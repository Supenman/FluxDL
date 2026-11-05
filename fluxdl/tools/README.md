# FluxDL 内置工具（yt-dlp / ffmpeg）

桌面端会**自动探测** exe 旁边的 `tools/` 目录，找到就直接内置使用，不需要用户手动安装、也不需要点「一键安装」下载。

二进制**不进 Git**（Linux 版 ffmpeg 165 MB，超过 GitHub 单文件 100 MB 上限，且会让仓库膨胀 270 MB）。仓库只保留本说明和获取脚本；正式成品包里会带上对应平台的二进制。

## 目录结构

```
tools/
├── README.md          ← 本说明
├── fetch-tools.sh     ← 按当前平台下载二进制
├── yt-dlp.exe         (Windows，构建时生成，不进 Git)
├── ffmpeg.exe         (Windows，构建时生成，不进 Git)
├── yt-dlp             (Linux，构建时生成，不进 Git)
└── ffmpeg             (Linux，构建时生成，不进 Git)
```

## 来源与体积（实测 2026-11）

| 平台 | 文件 | 体积 | 来源 |
|---|---|---|---|
| Windows | `yt-dlp.exe` | 22.5 MB | yt-dlp 官方 release（单文件） |
| Windows | `ffmpeg.exe` | 78 MB | `eugeneware/ffmpeg-static` b6.0 静态单文件 |
| Linux | `yt-dlp` | 3.0 MB | yt-dlp 官方 release（python zipapp） |
| Linux | `ffmpeg` | 165 MB | `imageio-ffmpeg` 静态二进制（ffmpeg 9.0.2） |

国内网络直连 GitHub release 常超时，脚本默认走 `ghfast.top` 加速镜像，可用 `YTDLP_BASE` / `FFMPEG_WIN_URL` / `FFMPEG_LINUX_URL` 环境变量覆盖。

## 用法

```bash
cd tools
./fetch-tools.sh          # 自动判断平台，下载到当前目录
```

然后正常 `npm run tauri dev` / `tauri build` 即可，程序启动时会自动把它们写进引擎设置。

## 用户手动指定路径仍然优先

`EngineOptions.ytDlpPath` / `ffmpegPath` 若指向一个**真实存在**的文件，程序会尊重用户设置，不覆盖为内置路径。只有默认值、空值或失效路径才会被内置工具顶上。
