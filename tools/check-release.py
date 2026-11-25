#!/usr/bin/env python3
"""Verify staged Windows release files before uploading them."""

import argparse
import hashlib
import json
import re
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_checksums(path: Path) -> dict[str, str]:
    checksums = {}
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        entry = re.fullmatch(r"([a-fA-F0-9]{64}) [ *](.+)", line)
        if not entry:
            raise ValueError(f"{path.name}:{number} 格式错误，应为 SHA-256 和文件名")
        digest, name = entry.groups()
        if name in checksums:
            raise ValueError(f"{path.name} 中有重复文件名：{name}")
        checksums[name] = digest.lower()
    return checksums


def check_release(directory: Path, tag: str) -> None:
    if not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?", tag):
        raise ValueError("发布标签应为 vMAJOR.MINOR.PATCH，可带预发布后缀（如 -beta.2）")
    version = tag[1:]
    manifest_path = directory / "update-manifest.json"
    manifest = read_json(manifest_path)
    with (ROOT / "src-tauri/Cargo.toml").open("rb") as handle:
        cargo = tomllib.load(handle)
    versions = {
        "package.json": read_json(ROOT / "package.json")["version"],
        "src-tauri/tauri.conf.json": read_json(ROOT / "src-tauri/tauri.conf.json")["version"],
        "src-tauri/Cargo.toml": cargo["package"]["version"],
        "发布产物 update-manifest.json": manifest["app"]["latest"],
    }
    for name, actual in versions.items():
        if actual != version:
            raise ValueError(f"{name} 版本为 {actual!r}，标签 {tag} 要求 {version}")

    asset = manifest["app"]["assets"]["windows-x64"]
    expected_url = f"https://github.com/Supenman/FluxDL/releases/download/{tag}/fluxdl.exe"
    if asset["url"] != expected_url:
        raise ValueError(f"更新清单的 Windows 下载地址应为 {expected_url}")

    checksums = read_checksums(directory / "SHA256SUMS.txt")
    installer = f"FluxDL-{version}-Setup.exe"
    for name in (installer, "fluxdl.exe", manifest_path.name):
        path = directory / name
        size = path.stat().st_size
        if size == 0:
            raise ValueError(f"{name} 是空文件")
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        if digest != checksums.get(name):
            raise ValueError(f"{name} 的 SHA-256 与 SHA256SUMS.txt 不一致，或缺少记录")
        if name == "fluxdl.exe":
            if type(asset["size"]) is not int or asset["size"] != size:
                raise ValueError("fluxdl.exe 的大小与更新清单不一致")
            if str(asset["sha256"]).lower() != digest:
                raise ValueError("fluxdl.exe 的 SHA-256 与更新清单不一致")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="准备发布的标签，例如 v0.4.0")
    parser.add_argument("--artifacts", required=True, type=Path, help="待发布产物目录")
    args = parser.parse_args()
    try:
        check_release(args.artifacts, args.tag)
    except (OSError, ValueError, KeyError, TypeError) as err:
        print(f"发布检查失败：{err}", file=sys.stderr)
        return 1
    print(f"{args.tag} 发布检查通过：版本、下载地址、文件大小和 SHA-256 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
