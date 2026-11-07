#!/usr/bin/env bash
# FluxDL 内置工具获取脚本：按当前平台下载 yt-dlp、ffmpeg 与 aria2c 到本目录。
# 二进制不进 Git；正式成品包由打包流程带上对应平台的文件。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

YTDLP_BASE="${YTDLP_BASE:-https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download}"
FFMPEG_WIN_URL="${FFMPEG_WIN_URL:-https://ghfast.top/https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64}"
# aria2c：视频下载走它的多连接分段拉取（-x16 -s16），绕开 B 站等站点的单连接限速。
# 版本钉死 1.37.0：更新需同步回归 tests/media_aria2.rs 与真实站点下载。
ARIA2_VERSION="${ARIA2_VERSION:-1.37.0}"
ARIA2_WIN_URL="${ARIA2_WIN_URL:-https://ghfast.top/https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-win-64bit-build1.zip}"

fetch() {
  local url="$1" dest="$2"
  echo "→ 下载 $(basename "$dest")"
  curl -fL --retry 3 --retry-delay 2 --max-time 300 -o "$dest" "$url"
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    fetch "$YTDLP_BASE/yt-dlp.exe" "yt-dlp.exe"
    fetch "$FFMPEG_WIN_URL" "ffmpeg.exe"
    # aria2c 只提供 zip，解压后取 exe，其它文件（证书、文档）不随包。
    echo "→ 下载 aria2c.exe（${ARIA2_VERSION}）"
    tmpzip="$(mktemp -d)/aria2.zip"
    curl -fL --retry 3 --retry-delay 2 --max-time 300 -o "$tmpzip" "$ARIA2_WIN_URL"
    unzip -o -j "$tmpzip" '*/aria2c.exe' -d . >/dev/null
    rm -rf "$(dirname "$tmpzip")"
    [[ -s aria2c.exe ]] || { echo "! aria2c.exe 解压失败"; exit 1; }
    echo "✓ Windows 工具就绪：yt-dlp.exe / ffmpeg.exe / aria2c.exe"
    ;;
  Linux)
    fetch "$YTDLP_BASE/yt-dlp" "yt-dlp"
    chmod +x yt-dlp
    # Linux 静态 ffmpeg 优先用系统包，避免额外拉 165 MB；
    # 需要随包内置时设置 FFMPEG_LINUX_URL 指向一个静态二进制。
    if [[ -n "${FFMPEG_LINUX_URL:-}" ]]; then
      fetch "$FFMPEG_LINUX_URL" "ffmpeg"
      chmod +x ffmpeg
    elif command -v ffmpeg >/dev/null 2>&1; then
      echo "✓ 使用系统 ffmpeg：$(command -v ffmpeg)"
    else
      echo "! 未找到 ffmpeg。请安装：sudo apt install -y ffmpeg"
      echo "  或设置 FFMPEG_LINUX_URL 指向静态二进制以下载到本目录。"
    fi
    echo "✓ Linux yt-dlp 就绪"
    ;;
  *)
    echo "! 暂不支持的平台：$(uname -s)。请手动放置 yt-dlp / ffmpeg 到本目录。"
    exit 1
    ;;
esac
