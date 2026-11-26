//! HuggingFace 模型/数据集与 GitHub Release 一键文件清单解析（参考 MDM `hub.rs`，零新增依赖）：
//!
//! - HuggingFace: `https://huggingface.co/{owner}/{repo}`（支持 `/tree/{rev}` 与 `/datasets/...`）
//!   调用公开树 API 列出文件、体积与 LFS SHA-256。
//! - GitHub Releases: `https://github.com/{owner}/{repo}/releases`（支持 `/tag/{tag}` 或 latest）
//!   调用公开 Releases API 列出全部发布资产、体积与 digest（SHA-256）。

use crate::manager::EngineError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubFileEntry {
    pub path: String,
    pub filename: String,
    pub url: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubListing {
    pub source: String,
    pub title: String,
    pub files: Vec<HubFileEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubTarget {
    HuggingFace {
        repo_type: &'static str, // "models" or "datasets"
        owner: String,
        repo: String,
        revision: String,
        subpath: String,
    },
    GitHubRelease {
        owner: String,
        repo: String,
        tag: Option<String>,
    },
    ModelScope {
        owner: String,
        repo: String,
        revision: String,
    },
}

/// 纯函数：识别 HuggingFace 仓库或 GitHub Release 链接。
pub fn parse_hub_target(raw_url: &str) -> Option<HubTarget> {
    let url = Url::parse(raw_url.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let segs: Vec<&str> = url
        .path_segments()?
        .filter(|s| !s.is_empty())
        .collect();

    if host == "huggingface.co" || host == "hf-mirror.com" {
        if segs.len() < 2 {
            return None;
        }
        let (repo_type, offset) = if segs[0] == "datasets" {
            if segs.len() < 3 {
                return None;
            }
            ("datasets", 1)
        } else if segs[0] == "spaces" {
            return None;
        } else {
            ("models", 0)
        };
        let owner = segs[offset].to_string();
        let repo = segs[offset + 1].to_string();
        // 排除单文件直链 /resolve/，直链应直接普通下载。
        if segs.get(offset + 2).copied() == Some("resolve") {
            return None;
        }
        let (revision, subpath) = if segs.get(offset + 2).copied() == Some("tree") {
            let rev = segs.get(offset + 3).copied().unwrap_or("main").to_string();
            let sub = if segs.len() > offset + 4 {
                segs[offset + 4..].join("/")
            } else {
                String::new()
            };
            (rev, sub)
        } else {
            ("main".to_string(), String::new())
        };
        return Some(HubTarget::HuggingFace {
            repo_type,
            owner,
            repo,
            revision,
            subpath,
        });
    }

    if host == "github.com" && segs.len() >= 3 && segs[2] == "releases" {
        // 排除 /releases/download/<tag>/<file> 直链
        if segs.get(3).copied() == Some("download") {
            return None;
        }
        let owner = segs[0].to_string();
        let repo = segs[1].to_string();
        let tag = if segs.get(3).copied() == Some("tag") {
            segs.get(4).map(|s| (*s).to_string())
        } else {
            None
        };
        return Some(HubTarget::GitHubRelease { owner, repo, tag });
    }

    if (host == "modelscope.cn" || host == "www.modelscope.cn")
        && segs.len() >= 3
        && segs[0] == "models"
    {
        // 排除单文件直链 /resolve/
        if segs.get(3).copied() == Some("resolve") {
            return None;
        }
        return Some(HubTarget::ModelScope {
            owner: segs[1].to_string(),
            repo: segs[2].to_string(),
            revision: "master".to_string(),
        });
    }

    None
}

fn build_hub_client(
    user_agent: &str,
    proxy: Option<&str>,
    use_system_proxy: bool,
) -> Result<Client, EngineError> {
    let mut builder = Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .dns_resolver(crate::dns::shared_resolver());
    if let Some(p) = proxy.filter(|s| !s.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(p.trim())?);
    } else if !use_system_proxy {
        builder = builder.no_proxy();
    }
    Ok(builder.build()?)
}

fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.split(['/', '\\']).any(|seg| seg == ".." || seg.contains(':'))
}

pub async fn resolve_hub_url(
    raw_url: &str,
    user_agent: &str,
    proxy: Option<&str>,
    use_system_proxy: bool,
) -> Result<HubListing, EngineError> {
    let target = parse_hub_target(raw_url)
        .ok_or_else(|| EngineError::message("当前链接不是受支持的 HuggingFace 仓库或 GitHub Release 页面"))?;
    let client = build_hub_client(user_agent, proxy, use_system_proxy)?;

    match target {
        HubTarget::HuggingFace {
            repo_type,
            owner,
            repo,
            revision,
            subpath,
        } => {
            let parsed_orig = Url::parse(raw_url.trim()).ok();
            let base_host = parsed_orig
                .as_ref()
                .and_then(|u| u.host_str())
                .filter(|h| h.eq_ignore_ascii_case("hf-mirror.com"))
                .unwrap_or("huggingface.co");

            let api_url = if subpath.is_empty() {
                format!("https://{base_host}/api/{repo_type}/{owner}/{repo}/tree/{revision}")
            } else {
                format!("https://{base_host}/api/{repo_type}/{owner}/{repo}/tree/{revision}/{subpath}")
            };

            let resp = client.get(&api_url).send().await?;
            if !resp.status().is_success() {
                return Err(EngineError::message(format!(
                    "拉取 HuggingFace 文件列表失败：HTTP {}",
                    resp.status().as_u16()
                )));
            }
            let items: Vec<serde_json::Value> = resp.json().await?;
            let prefix = if repo_type == "datasets" {
                format!("https://{base_host}/datasets/{owner}/{repo}/resolve/{revision}")
            } else {
                format!("https://{base_host}/{owner}/{repo}/resolve/{revision}")
            };

            let mut files = Vec::new();
            for item in items {
                if item.get("type").and_then(|v| v.as_str()) != Some("file") {
                    continue;
                }
                let Some(path) = item.get("path").and_then(|v| v.as_str()) else {
                    continue;
                };
                if !is_safe_relative_path(path) {
                    continue;
                }
                let filename = path.rsplit('/').next().unwrap_or(path).to_string();
                let size = item
                    .get("lfs")
                    .and_then(|l| l.get("size"))
                    .and_then(|v| v.as_u64())
                    .or_else(|| item.get("size").and_then(|v| v.as_u64()))
                    .unwrap_or(0);
                let sha256 = item
                    .get("lfs")
                    .and_then(|l| l.get("oid"))
                    .and_then(|v| v.as_str())
                    .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
                    .map(|s| s.to_ascii_lowercase());

                files.push(HubFileEntry {
                    path: path.to_string(),
                    filename,
                    url: format!("{prefix}/{path}?download=true"),
                    size,
                    sha256,
                });
            }

            Ok(HubListing {
                source: "HuggingFace".to_string(),
                title: format!("{owner}/{repo} ({revision})"),
                files,
            })
        }
        HubTarget::GitHubRelease { owner, repo, tag } => {
            let api_url = match &tag {
                Some(t) => format!("https://api.github.com/repos/{owner}/{repo}/releases/tags/{t}"),
                None => format!("https://api.github.com/repos/{owner}/{repo}/releases/latest"),
            };
            let resp = client
                .get(&api_url)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await?;
            if !resp.status().is_success() {
                return Err(EngineError::message(format!(
                    "拉取 GitHub Release 资产失败：HTTP {}",
                    resp.status().as_u16()
                )));
            }
            let body: serde_json::Value = resp.json().await?;
            let release_name = body
                .get("tag_name")
                .and_then(|v| v.as_str())
                .or_else(|| tag.as_deref())
                .unwrap_or("latest")
                .to_string();

            let mut files = Vec::new();
            if let Some(assets) = body.get("assets").and_then(|v| v.as_array()) {
                for asset in assets {
                    let Some(name) = asset.get("name").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let Some(dl_url) = asset.get("browser_download_url").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let size = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                    let sha256 = asset
                        .get("digest")
                        .and_then(|v| v.as_str())
                        .and_then(|raw| crate::verify::parse_user_sha256(raw).ok());
                    files.push(HubFileEntry {
                        path: name.to_string(),
                        filename: name.to_string(),
                        url: dl_url.to_string(),
                        size,
                        sha256,
                    });
                }
            }

            Ok(HubListing {
                source: "GitHub Release".to_string(),
                title: format!("{owner}/{repo} {release_name}"),
                files,
            })
        }
        HubTarget::ModelScope {
            owner,
            repo,
            revision,
        } => {
            let api_url = format!(
                "https://modelscope.cn/api/v1/models/{owner}/{repo}/repo/files?Revision={revision}&Recursive=True"
            );
            let resp = client.get(&api_url).send().await?;
            if !resp.status().is_success() {
                return Err(EngineError::message(format!(
                    "拉取 ModelScope 模型文件失败：HTTP {}",
                    resp.status().as_u16()
                )));
            }
            let body: serde_json::Value = resp.json().await?;
            let list = body
                .get("Data")
                .and_then(|d| d.get("Files"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut files = Vec::new();
            for item in list {
                let kind = item.get("Type").and_then(|v| v.as_str()).unwrap_or("");
                if !kind.eq_ignore_ascii_case("blob") {
                    continue;
                }
                let Some(path) = item.get("Path").and_then(|v| v.as_str()) else {
                    continue;
                };
                if !is_safe_relative_path(path) {
                    continue;
                }
                let filename = item
                    .get("Name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path).to_string());
                let size = item.get("Size").and_then(|v| v.as_u64()).unwrap_or(0);
                let sha256 = item
                    .get("Sha256")
                    .and_then(|v| v.as_str())
                    .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
                    .map(|s| s.to_ascii_lowercase());
                let dl_url = format!(
                    "https://modelscope.cn/models/{owner}/{repo}/resolve/{revision}/{path}"
                );
                files.push(HubFileEntry {
                    path: path.to_string(),
                    filename,
                    url: dl_url,
                    size,
                    sha256,
                });
            }

            Ok(HubListing {
                source: "ModelScope".to_string(),
                title: format!("{owner}/{repo} ({revision})"),
                files,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_modelscope_urls() {
        assert_eq!(
            parse_hub_target("https://modelscope.cn/models/Qwen/Qwen2.5-7B-Instruct/files"),
            Some(HubTarget::ModelScope {
                owner: "Qwen".into(),
                repo: "Qwen2.5-7B-Instruct".into(),
                revision: "master".into(),
            })
        );
        assert_eq!(
            parse_hub_target("https://modelscope.cn/models/Qwen/Qwen2.5-7B-Instruct/resolve/master/a.safetensors"),
            None
        );
    }

    use super::*;

    #[test]
    fn parses_hf_model_and_dataset_urls() {
        assert_eq!(
            parse_hub_target("https://huggingface.co/Qwen/Qwen3-8B"),
            Some(HubTarget::HuggingFace {
                repo_type: "models",
                owner: "Qwen".into(),
                repo: "Qwen3-8B".into(),
                revision: "main".into(),
                subpath: String::new(),
            })
        );
        assert_eq!(
            parse_hub_target("https://hf-mirror.com/datasets/org/ds/tree/v2/sub"),
            Some(HubTarget::HuggingFace {
                repo_type: "datasets",
                owner: "org".into(),
                repo: "ds".into(),
                revision: "v2".into(),
                subpath: "sub".into(),
            })
        );
        // 单文件直链不走仓库解析
        assert_eq!(
            parse_hub_target("https://huggingface.co/Qwen/Qwen3-8B/resolve/main/model.safetensors"),
            None
        );
    }

    #[test]
    fn parses_github_release_urls() {
        assert_eq!(
            parse_hub_target("https://github.com/Supenman/FluxDL/releases/tag/v0.4.0"),
            Some(HubTarget::GitHubRelease {
                owner: "Supenman".into(),
                repo: "FluxDL".into(),
                tag: Some("v0.4.0".into()),
            })
        );
        assert_eq!(
            parse_hub_target("https://github.com/Supenman/FluxDL/releases"),
            Some(HubTarget::GitHubRelease {
                owner: "Supenman".into(),
                repo: "FluxDL".into(),
                tag: None,
            })
        );
        // 资产直链不走仓库解析
        assert_eq!(
            parse_hub_target("https://github.com/Supenman/FluxDL/releases/download/v0.4.0/fluxdl.exe"),
            None
        );
    }
}
