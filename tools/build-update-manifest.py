#!/usr/bin/env python3
"""生成 FluxDL 的 update-manifest.json（版本清单）。

清单是客户端唯一的版本信息来源：应用最新版、各平台单文件 exe 的下载地址与
sha256、随包工具的可用版本、以及更新历史。发布时跑一次即可。

用法：
    python3 tools/build-update-manifest.py \
        --version 0.2.0 \
        --exe path/to/fluxdl.exe \
        --notes "设置页新增版本管理" "更新失败自动回滚" \
        --out update-manifest.json

历史会累积：默认读 `--out` 已有的 history，把新版本插到最前；
用 `--reset-history` 可以从头开始。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
DEFAULT_REPO = "Supenman/FuxDL"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def asset_from(path: Path, url: str) -> dict:
    return {
        "url": url,
        "size": path.stat().st_size,
        "sha256": sha256_of(path),
    }


def upsert_history(history: list[dict], entry: dict) -> list[dict]:
    """同版本重发时覆盖，不产生重复条目。"""
    rest = [item for item in history if item.get("version") != entry["version"]]
    return [entry, *rest]


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 FluxDL 版本清单")
    parser.add_argument("--version", required=True, help="版本号，如 0.2.0（语义化版本）")
    parser.add_argument("--exe", required=True, help="本版本的单文件 fluxdl.exe")
    parser.add_argument("--notes", nargs="*", default=[], help="本版本更新说明，每条一句")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"owner/repo，默认 {DEFAULT_REPO}")
    parser.add_argument("--tag", default=None, help="Release tag，默认 v<version>")
    parser.add_argument("--asset-name", default=None, help="Release 上的附件名，默认 fluxdl.exe")
    parser.add_argument("--platform", default="windows-x64", help="平台标识，默认 windows-x64")
    parser.add_argument(
        "--min-supported",
        default=None,
        help="低于该版本必须强制更新；一般留空",
    )
    parser.add_argument(
        "--tool",
        action="append",
        default=[],
        metavar="NAME=VERSION",
        help="随包工具的最新版本，可重复，如 --tool yt-dlp=2025.11.01",
    )
    parser.add_argument("--out", default="update-manifest.json", help="输出路径")
    parser.add_argument("--reset-history", action="store_true", help="丢弃已有历史")
    parser.add_argument(
        "--released-at",
        default=None,
        help="发布时间（ISO8601），默认当前 UTC 时间",
    )
    args = parser.parse_args()

    exe = Path(args.exe)
    if not exe.is_file():
        print(f"找不到可执行文件：{exe}", file=sys.stderr)
        return 1
    if not args.notes:
        print("建议至少给一条更新说明（--notes），否则界面提示为空", file=sys.stderr)

    out = Path(args.out)
    history: list[dict] = []
    tools: dict[str, dict] = {}
    if out.is_file() and not args.reset_history:
        try:
            old = json.loads(out.read_text(encoding="utf-8"))
            history = old.get("history", [])
            tools = old.get("tools", {})
        except (json.JSONDecodeError, OSError) as err:
            print(f"旧清单读取失败（将重建）：{err}", file=sys.stderr)

    for item in args.tool:
        if "=" not in item:
            print(f"--tool 需要 NAME=VERSION 形式：{item}", file=sys.stderr)
            return 1
        name, version = item.split("=", 1)
        tools.setdefault(name, {"versions": []})["latest"] = version

    released_at = args.released_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tag = args.tag or f"v{args.version}"
    asset_name = args.asset_name or "fluxdl.exe"
    url = f"https://github.com/{args.repo}/releases/download/{tag}/{asset_name}"

    manifest = {
        "schema": SCHEMA,
        "app": {
            "latest": args.version,
            "minSupported": args.min_supported,
            "releasedAt": released_at,
            "notes": args.notes,
            "assets": {args.platform: asset_from(exe, url)},
        },
        "tools": tools,
        "history": upsert_history(
            history,
            {
                "version": args.version,
                "releasedAt": released_at,
                "channel": "stable",
                "notes": args.notes,
            },
        ),
    }

    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {out}")
    print(f"  版本      : {args.version}")
    print(f"  体积      : {exe.stat().st_size:,} 字节")
    print(f"  sha256    : {manifest['app']['assets'][args.platform]['sha256']}")
    print(f"  下载地址  : {url}")
    print(f"  历史条目  : {len(manifest['history'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
