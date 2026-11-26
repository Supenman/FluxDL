//! 远程 ZIP 在线预览与单文件精准提取（参考 MDM `remotezip.rs`，零新增外部依赖）：
//!
//! 复用 `src-tauri` 已有的 `reqwest` 与 `zip` 依赖，通过带 128 KiB 块缓存的
//! `HttpRangeReader` 实现 `std::io::Read + std::io::Seek`，交由 `zip::ZipArchive`
//! 原生完成 ZIP32/ZIP64 解析、Deflate 解压、CRC-32 校验与 Zip-Slip 路径安全检查。

use reqwest::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CACHE_BLOCK: u64 = 128 * 1024;
const MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteZipEntry {
    pub name: String,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteZipListing {
    pub url: String,
    pub total_size: u64,
    pub entries: Vec<RemoteZipEntry>,
}

struct HttpRangeReader {
    rt: tokio::runtime::Handle,
    client: Client,
    url: String,
    len: u64,
    pos: u64,
    buf_start: u64,
    buf: Vec<u8>,
}

impl HttpRangeReader {
    fn open(
        rt: tokio::runtime::Handle,
        url: &str,
        user_agent: &str,
        proxy: Option<&str>,
        use_system_proxy: bool,
    ) -> Result<Self, String> {
        let mut builder = Client::builder()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30));
        if let Some(p) = proxy.filter(|s| !s.trim().is_empty()) {
            builder = builder
                .proxy(reqwest::Proxy::all(p.trim()).map_err(|e| format!("代理配置无效：{e}"))?);
        } else if !use_system_proxy {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;

        let (final_url, len) = rt.block_on(async {
            let resp = client
                .get(url)
                .header(RANGE, "bytes=0-0")
                .send()
                .await
                .map_err(|e| format!("探测远程 ZIP 失败：{e}"))?;
            let status = resp.status();
            if status != StatusCode::PARTIAL_CONTENT {
                let supports_ranges = resp
                    .headers()
                    .get(ACCEPT_RANGES)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_ascii_lowercase().contains("bytes"))
                    .unwrap_or(false);
                if !supports_ranges {
                    return Err("该服务器不支持 Range 分段请求，无法在线预览 ZIP".to_string());
                }
            }
            let total = resp
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|raw| raw.rsplit('/').next())
                .and_then(|n| n.trim().parse::<u64>().ok())
                .or_else(|| {
                    if status == StatusCode::OK {
                        resp.headers()
                            .get(CONTENT_LENGTH)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|n| n.trim().parse::<u64>().ok())
                    } else {
                        None
                    }
                })
                .ok_or_else(|| "无法获取远程 ZIP 总大小".to_string())?;
            Ok((resp.url().to_string(), total))
        })?;

        if len < 22 {
            return Err("目标文件过小，不是有效的 ZIP 压缩包".to_string());
        }

        Ok(Self {
            rt,
            client,
            url: final_url,
            len,
            pos: 0,
            buf_start: 0,
            buf: Vec::new(),
        })
    }

    fn fill_window(&mut self, offset: u64, min_bytes: u64) -> io::Result<()> {
        if offset >= self.len {
            self.buf.clear();
            self.buf_start = self.len;
            return Ok(());
        }
        let want = min_bytes.max(CACHE_BLOCK);
        let end = offset.saturating_add(want).saturating_sub(1).min(self.len - 1);
        let url = self.url.clone();
        let client = self.client.clone();
        let bytes = self
            .rt
            .block_on(async move {
                let resp = client
                    .get(&url)
                    .header(RANGE, format!("bytes={offset}-{end}"))
                    .send()
                    .await
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
                if resp.status() != StatusCode::PARTIAL_CONTENT && !resp.status().is_success() {
                    return Err(io::Error::new(
                        io::ErrorKind::Other,
                        format!("Range 读取失败：HTTP {}", resp.status().as_u16()),
                    ));
                }
                resp.bytes()
                    .await
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
            })?;
        self.buf_start = offset;
        self.buf = bytes.to_vec();
        Ok(())
    }
}

impl Read for HttpRangeReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        let buf_end = self.buf_start.saturating_add(self.buf.len() as u64);
        if self.pos < self.buf_start || self.pos >= buf_end {
            self.fill_window(self.pos, out.len() as u64)?;
        }
        let buf_end = self.buf_start.saturating_add(self.buf.len() as u64);
        if self.pos >= buf_end {
            return Ok(0);
        }
        let rel = (self.pos - self.buf_start) as usize;
        let avail = self.buf.len().saturating_sub(rel);
        let n = avail.min(out.len());
        out[..n].copy_from_slice(&self.buf[rel..rel + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeReader {
    fn seek(&mut self, style: SeekFrom) -> io::Result<u64> {
        let next: i128 = match style {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => self.len as i128 + n as i128,
            SeekFrom::Current(n) => self.pos as i128 + n as i128,
        };
        if next < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid seek to a negative position",
            ));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

pub fn list_remote_zip(
    rt: tokio::runtime::Handle,
    url: &str,
    user_agent: &str,
    proxy: Option<&str>,
    use_system_proxy: bool,
) -> Result<RemoteZipListing, String> {
    let reader = HttpRangeReader::open(rt, url, user_agent, proxy, use_system_proxy)?;
    let final_url = reader.url.clone();
    let total_size = reader.len;
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("解析远程 ZIP 目录失败：{e}"))?;

    let mut entries = Vec::new();
    let count = archive.len().min(MAX_ENTRIES);
    for i in 0..count {
        let Ok(file) = archive.by_index_raw(i) else {
            continue;
        };
        if file.is_dir() {
            continue;
        }
        // 防路径穿越：只展示安全相对路径条目
        if file.enclosed_name().is_none() {
            continue;
        }
        entries.push(RemoteZipEntry {
            name: file.name().to_string(),
            compressed_size: file.compressed_size(),
            uncompressed_size: file.size(),
        });
    }

    Ok(RemoteZipListing {
        url: final_url,
        total_size,
        entries,
    })
}

pub fn extract_remote_zip_entries(
    rt: tokio::runtime::Handle,
    url: &str,
    entry_names: &[String],
    save_dir: &Path,
    user_agent: &str,
    proxy: Option<&str>,
    use_system_proxy: bool,
) -> Result<Vec<String>, String> {
    if entry_names.is_empty() {
        return Err("请至少勾选一个要提取的文件".to_string());
    }
    std::fs::create_dir_all(save_dir).map_err(|e| format!("创建保存目录失败：{e}"))?;

    let reader = HttpRangeReader::open(rt, url, user_agent, proxy, use_system_proxy)?;
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("打开远程 ZIP 失败：{e}"))?;

    let mut saved = Vec::new();
    for name in entry_names {
        let mut entry = archive
            .by_name(name)
            .map_err(|e| format!("未找到条目 {name}：{e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let out_path: PathBuf = save_dir.join(enclosed);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut out_file =
            std::fs::File::create(&out_path).map_err(|e| format!("创建文件失败：{e}"))?;
        io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("提取 {name} 失败：{e}"))?;
        saved.push(out_path.to_string_lossy().to_string());
    }
    Ok(saved)
}
