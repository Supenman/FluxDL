#!/usr/bin/env bash
# FluxDL 内置工具获取脚本：按当前平台下载 yt-dlp 与 ffmpeg 到本目录。
# 二进制不进 Git；正式成品包由打包流程带上对应平台的文件。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

YTDLP_BASE="${YTDLP_BASE:-https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download}"
FFMPEG_WIN_URL="${FFMPEG_WIN_URL:-https://ghfast.top/https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64}"

fetch() {
  local url="$1" dest="$2"
  echo "→ 下载 $(basename "$dest")"
  curl -fL --retry 3 --retry-delay 2 --max-time 300 -o "$dest" "$url"
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    fetch "$YTDLP_BASE/yt-dlp.exe" "yt-dlp.exe"
    fetch "$FFMPEG_WIN_URL" "ffmpeg.exe"
    echo "✓ Windows 工具就绪：yt-dlp.exe / ffmpeg.exe"
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
