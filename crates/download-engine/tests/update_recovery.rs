//! 版本管理端到端：真实文件、真实 sha256、真实替换与回滚。
//!
//! 单元测试覆盖了各函数，这里验证**整条链路**：
//! 下载暂存 → 校验 → 脚本式替换 → 新文件损坏 → 启动恢复 → 回到旧版本。

use std::path::PathBuf;

use fluxdl_engine::update::{
    self, verify_file, Asset, Recovery, SwapState,
};

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fluxdl-update-flow-{name}-{}-{}",
        std::process::id(),
        update::now_ms()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn staged_update_is_verified_before_swap() {
    let dir = workdir("stage");
    let target = dir.join("fluxdl.exe");
    std::fs::write(&target, b"V0.1-BINARY").unwrap();

    let new_bytes = b"V0.2-BINARY-WITH-MORE-CODE";
    let staged = update::staged_path(&target);
    std::fs::write(&staged, new_bytes).unwrap();

    let asset = Asset {
        url: "https://example.invalid/fluxdl.exe".into(),
        size: Some(new_bytes.len() as u64),
        sha256: Some(update::sha256_hex(new_bytes)),
    };
    verify_file(&staged, &asset).expect("正确的包必须通过校验");

    // 故意破坏一个字节，模拟下载被截断 / 中间被改写
    let mut broken = new_bytes.to_vec();
    broken[3] = b'X';
    std::fs::write(&staged, &broken).unwrap();
    let err = verify_file(&staged, &asset).expect_err("内容变了必须被拒绝");
    assert!(err.contains("校验失败"), "错误信息要说人话：{err}");

    // 主文件没有被碰过
    assert_eq!(std::fs::read(&target).unwrap(), b"V0.1-BINARY");
}

#[test]
fn corrupt_new_binary_rolls_back_on_next_start() {
    let dir = workdir("rollback");
    let target = dir.join("fluxdl.exe");
    let old_bytes = b"V0.1-STABLE-BINARY";
    let new_bytes = b"V0.2-NEW-BINARY";
    std::fs::write(&target, old_bytes).unwrap();

    // 1. 下载到暂存并校验通过
    let staged = update::staged_path(&target);
    std::fs::write(&staged, new_bytes).unwrap();
    update::write_state(
        &dir,
        &SwapState {
            component: "app".into(),
            from_version: "0.1.0".into(),
            to_version: "0.2.0".into(),
            target: target.to_string_lossy().to_string(),
            backup: update::backup_path(&target).to_string_lossy().to_string(),
            staged: staged.to_string_lossy().to_string(),
            expect_sha256: update::sha256_hex(new_bytes),
            started_at: update::now_ms(),
        },
    )
    .unwrap();

    // 2. 模拟替换脚本执行：备份 → 换名（与 apply_script 里的命令等价）
    let backup = update::backup_path(&target);
    std::fs::rename(&target, &backup).unwrap();
    std::fs::rename(&staged, &target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), new_bytes);

    // 3. 新版本写入后磁盘出问题（这里直接改写文件模拟损坏）
    std::fs::write(&target, b"V0.2-CORRUPTED").unwrap();

    // 4. 下次启动：sha 对不上 → 自动回滚
    match update::recover(&dir, &target) {
        Recovery::RolledBack(reason) => {
            assert!(reason.contains("回滚"), "要能说清发生了什么：{reason}");
        }
        other => panic!("应判定为回滚，实际是 {other:?}"),
    }
    assert_eq!(
        std::fs::read(&target).unwrap(),
        old_bytes,
        "必须恢复到能正常启动的旧版本"
    );
    assert!(std::fs::read(update::state_path(&dir)).is_err() || {
        // state 被清掉；允许文件存在但内容为空的极端情况
        update::read_state(&dir).is_none()
    });
}

#[test]
fn successful_swap_cleans_up_and_keeps_new_binary() {
    let dir = workdir("commit");
    let target = dir.join("fluxdl.exe");
    let new_bytes = b"V0.2-GOOD";
    std::fs::write(&target, b"V0.1-OLD").unwrap();
    let staged = update::staged_path(&target);
    std::fs::write(&staged, new_bytes).unwrap();
    update::write_state(
        &dir,
        &SwapState {
            component: "app".into(),
            to_version: "0.2.0".into(),
            expect_sha256: update::sha256_hex(new_bytes),
            ..Default::default()
        },
    )
    .unwrap();

    update::swap_in_place(&target).unwrap();
    assert_eq!(update::recover(&dir, &target), Recovery::Committed);
    assert_eq!(std::fs::read(&target).unwrap(), new_bytes);
    assert!(!update::backup_path(&target).exists(), "成功后不该留下 .bak 占空间");
    assert!(!update::staged_path(&target).exists());
}

#[test]
fn missing_target_is_restored_from_backup() {
    let dir = workdir("missing");
    let target = dir.join("fluxdl.exe");
    // 只有备份：模拟「先删了旧文件、新文件还没到位」时进程被杀
    std::fs::write(update::backup_path(&target), b"V0.1-OLD").unwrap();
    update::write_state(
        &dir,
        &SwapState {
            component: "app".into(),
            to_version: "0.2.0".into(),
            expect_sha256: update::sha256_hex(b"V0.2-NEW"),
            ..Default::default()
        },
    )
    .unwrap();

    assert!(matches!(
        update::recover(&dir, &target),
        Recovery::RolledBack(_)
    ));
    assert_eq!(std::fs::read(&target).unwrap(), b"V0.1-OLD");
}

#[test]
fn tool_slot_tracks_previous_for_one_click_rollback() {
    let dir = workdir("tools");
    let file = dir.join("tool-state.json");
    let mut state = update::ToolState::load(&file);

    // 随包版本先登场
    state.activate("yt-dlp", "2025.10.15");
    // 用户升到新版本
    state.activate("yt-dlp", "2025.11.01");
    state.save(&file).unwrap();

    let reloaded = update::ToolState::load(&file);
    let slot = reloaded.slot("yt-dlp");
    assert_eq!(slot.active.as_deref(), Some("2025.11.01"));
    assert_eq!(
        slot.previous.as_deref(),
        Some("2025.10.15"),
        "回滚按钮依赖 previous，必须持久化"
    );

    // 回滚 = 把 previous 再激活一次
    let mut state = reloaded;
    state.activate("yt-dlp", "2025.10.15");
    assert_eq!(state.slot("yt-dlp").active.as_deref(), Some("2025.10.15"));
    assert_eq!(
        state.slot("yt-dlp").previous.as_deref(),
        Some("2025.11.01"),
        "回滚后还能再回滚回去"
    );
}
