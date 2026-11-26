//! 磁盘与稀疏文件辅助（零新增外部依赖）：
//! 1. Windows NTFS 稀疏 .part 文件：大文件在 `set_len` 前开启稀疏属性，
//!    避免多线程写中间偏移时触发 NTFS 同步填零卡顿；写完校验通过后清除稀疏标记。
//! 2. 下载前磁盘可用空间预检：拿到 `Content-Length` 后先核对目标分区剩余空间，
//!    避免下载到末尾才因磁盘满报错。

use std::fmt;
use std::fs::File;
use std::path::{Path, PathBuf};

/// 超过 5 MiB 的文件才标记稀疏属性，小文件直接分配开销极低。
pub const SPARSE_MIN_BYTES: u64 = 5 * 1024 * 1024;

/// 预留 32 MiB 系统缓冲余量，避免把目标分区写到 0 字节导致临时状态文件写入失败。
pub const FREE_SPACE_HEADROOM: u64 = 32 * 1024 * 1024;

/// 磁盘空间不足错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskSpaceError {
    pub required_bytes: u64,
    pub available_bytes: u64,
}

impl fmt::Display for DiskSpaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "目标磁盘剩余空间不足：还需要约 {}（含 32 MB 安全余量），当前仅剩 {}，请清理磁盘或更换保存目录",
            format_bytes(self.required_bytes),
            format_bytes(self.available_bytes)
        )
    }
}

impl std::error::Error for DiskSpaceError {}

/// 为 `.part` 文件开启或关闭稀疏属性。
///
/// - Windows NTFS：通过 `DeviceIoControl(FSCTL_SET_SPARSE)` 设置。
///   在 FAT32 / exFAT 等不支持稀疏的文件系统上静默返回 `false`，不影响正常下载。
/// - 非 Windows（Linux / macOS）：`set_len` (`ftruncate`) 在主流文件系统上天然稀疏，返回 `false`。
pub fn set_sparse(file: &File, sparse: bool) -> bool {
    imp::set_sparse(file, sparse)
}

/// 查询目标路径所在分区的当前用户可用字节数。
/// 若路径尚未创建，会向上回溯至最近已存在的祖先目录。
/// 在当前平台无法获取时返回 `None`（跳过预检，不误报）。
pub fn available_space(path: &Path) -> Option<u64> {
    let existing = nearest_existing_dir(path)?;
    imp::available_space(&existing)
}

/// 下载前核对剩余空间：扣除已写入的续传字节，并加上 `FREE_SPACE_HEADROOM` 安全余量。
pub fn check_free_space(
    dir: &Path,
    total_bytes: u64,
    already_written: u64,
) -> Result<(), DiskSpaceError> {
    if total_bytes == 0 {
        return Ok(());
    }
    let Some(available) = available_space(dir) else {
        return Ok(());
    };
    evaluate_free_space(available, total_bytes, already_written)
}

/// 纯函数判定逻辑，便于跨平台单测。
pub fn evaluate_free_space(
    available: u64,
    total_bytes: u64,
    already_written: u64,
) -> Result<(), DiskSpaceError> {
    if total_bytes == 0 {
        return Ok(());
    }
    let remaining = total_bytes.saturating_sub(already_written);
    let required = remaining.saturating_add(FREE_SPACE_HEADROOM);
    if available < required {
        return Err(DiskSpaceError {
            required_bytes: required,
            available_bytes: available,
        });
    }
    Ok(())
}

fn nearest_existing_dir(path: &Path) -> Option<PathBuf> {
    let mut cur = path;
    loop {
        if cur.exists() {
            return if cur.is_dir() {
                Some(cur.to_path_buf())
            } else {
                cur.parent().map(Path::to_path_buf)
            };
        }
        cur = cur.parent()?;
    }
}

pub fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(windows)]
mod imp {
    use core::ffi::c_void;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;

    // CTL_CODE(FILE_DEVICE_FILE_SYSTEM=9, 49, METHOD_BUFFERED=0, FILE_SPECIAL_ACCESS=0)
    const FSCTL_SET_SPARSE: u32 = 0x0009_00C4;

    #[repr(C)]
    struct FileSetSparseBuffer {
        set_sparse: u8,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            h_device: *mut c_void,
            dw_io_control_code: u32,
            lp_in_buffer: *const c_void,
            n_in_buffer_size: u32,
            lp_out_buffer: *mut c_void,
            n_out_buffer_size: u32,
            lp_bytes_returned: *mut u32,
            lp_overlapped: *mut c_void,
        ) -> i32;

        fn GetDiskFreeSpaceExW(
            lp_directory_name: *const u16,
            lp_free_bytes_available_to_caller: *mut u64,
            lp_total_number_of_bytes: *mut u64,
            lp_total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    pub fn set_sparse(file: &File, sparse: bool) -> bool {
        let buf = FileSetSparseBuffer {
            set_sparse: u8::from(sparse),
        };
        let mut returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_SET_SPARSE,
                (&buf as *const FileSetSparseBuffer).cast::<c_void>(),
                core::mem::size_of::<FileSetSparseBuffer>() as u32,
                core::ptr::null_mut(),
                0,
                &mut returned,
                core::ptr::null_mut(),
            )
        };
        ok != 0
    }

    pub fn available_space(dir: &Path) -> Option<u64> {
        let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
        wide.push(0);
        let mut avail: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut avail,
                core::ptr::null_mut(),
                core::ptr::null_mut(),
            )
        };
        if ok != 0 {
            Some(avail)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::fs::File;
    use std::path::Path;

    pub fn set_sparse(_file: &File, _sparse: bool) -> bool {
        false
    }

    pub fn available_space(_dir: &Path) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluate_free_space_allows_sufficient_space() {
        let total = 500 * 1024 * 1024;
        let avail = 600 * 1024 * 1024;
        assert!(evaluate_free_space(avail, total, 0).is_ok());
    }

    #[test]
    fn evaluate_free_space_rejects_when_below_headroom() {
        let total = 500 * 1024 * 1024;
        let avail = total + FREE_SPACE_HEADROOM - 1;
        let err = evaluate_free_space(avail, total, 0).unwrap_err();
        assert_eq!(err.required_bytes, total + FREE_SPACE_HEADROOM);
        assert_eq!(err.available_bytes, avail);
        assert!(err.to_string().contains("目标磁盘剩余空间不足"));
    }

    #[test]
    fn evaluate_free_space_accounts_for_resumed_bytes() {
        let total = 1024 * 1024 * 1024;
        let written = 900 * 1024 * 1024;
        // 剩余仅需 124 MB + 32 MB = 156 MB，200 MB 足够
        assert!(evaluate_free_space(200 * 1024 * 1024, total, written).is_ok());
        // 100 MB 不够
        assert!(evaluate_free_space(100 * 1024 * 1024, total, written).is_err());
    }

    #[test]
    fn evaluate_free_space_skips_unknown_total() {
        assert!(evaluate_free_space(0, 0, 0).is_ok());
    }

    #[test]
    fn format_bytes_readable() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(10 * 1024 * 1024), "10.0 MB");
        assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2.00 GB");
    }
}
