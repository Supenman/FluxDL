import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  FolderOpen,
  RefreshCw,
  Check,
  Loader2,
  Sun,
  Moon,
  Monitor,
  Download,
  Film,
  Sparkles,
  Gauge,
  Globe,
  Clipboard,
  Power,
  Info,
  HardDrive,
  Settings2,
} from "lucide-react";
import { useStore } from "../store";
import { backend, isTauri } from "../lib/backend";
import type { EngineInfo, EngineOptions, ToolProgress } from "../lib/types";
import { cx, formatBytes, formatSpeed } from "../lib/format";

const LIMITS = [
  { value: null, label: "不限速" },
  { value: 512 * 1024, label: "512 KB/s" },
  { value: 1024 * 1024, label: "1 MB/s" },
  { value: 2 * 1024 * 1024, label: "2 MB/s" },
  { value: 5 * 1024 * 1024, label: "5 MB/s" },
  { value: 10 * 1024 * 1024, label: "10 MB/s" },
];

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      className={cx("switch", checked && "on")}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const setSettings = useStore((s) => s.setSettings);
  const pushToast = useStore((s) => s.pushToast);

  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<ToolProgress | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    void refreshInfo();
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void backend.onToolProgress((next) => setProgress(next)).then((fn) => {
      if (cancelled) fn();
      else dispose = fn;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const install = async () => {
    if (installing) return;
    setInstalling(true);
    setProgress(null);
    try {
      const result = await backend.installTools();
      update({
        ytDlpPath: result.ytDlpPath,
        ffmpegPath: result.ffmpegPath,
      });
      await refreshInfo();
      pushToast("yt-dlp 与 ffmpeg 已安装完成", "info");
    } catch (error) {
      pushToast(`安装失败：${error}`, "error");
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  async function refreshInfo() {
    setChecking(true);
    try {
      setInfo(await backend.engineInfo());
    } catch {
      setInfo(null);
    } finally {
      setChecking(false);
    }
  }

  const update = (patch: Partial<EngineOptions>) => {
    setSettings(patch);
    setSaved(false);
    if (patch.clipboardWatch !== undefined) {
      void backend.setClipboardWatch(patch.clipboardWatch);
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const next = useStore.getState().settings;
      try {
        await backend.setEngineOptions(next);
        setSaved(true);
      } catch (error) {
        pushToast(`设置保存失败：${error}`, "error");
      }
    }, 450);
  };

  const pickDir = async () => {
    const picked = await backend.pickFolder(settings.saveDir);
    if (picked) update({ saveDir: picked });
  };

  const pickYtDlp = async () => {
    const picked = await backend.pickFile(settings.ytDlpPath);
    if (picked) {
      update({ ytDlpPath: picked });
      window.setTimeout(() => void refreshInfo(), 700);
    }
  };

  const pickFfmpeg = async () => {
    const picked = await backend.pickFile(settings.ffmpegPath ?? "");
    if (picked) {
      update({ ffmpegPath: picked });
      window.setTimeout(() => void refreshInfo(), 700);
    }
  };

  return (
    <div className="settings-page">
      <header className="settings-head">
        <div>
          <h1>设置</h1>
          <p>所有修改都会自动保存在本机，无需重启应用。</p>
        </div>
        <div className={cx("save-state", saved ? "saved" : "saving")}>
          {saved ? <Check size={13} /> : <Loader2 size={13} className="spin" />}
          {saved ? "已保存" : "保存中…"}
        </div>
      </header>

      <section className="settings-section">
        <div className="section-head">
          <span className="section-icon">
            <Settings2 size={16} />
          </span>
          <div>
            <h2>外观</h2>
            <p>深色界面在夜里更安静，浅色界面更适合白天。</p>
          </div>
        </div>
        <div className="theme-picker">
          {(
            [
              { id: "dark", label: "深色", icon: Moon },
              { id: "light", label: "浅色", icon: Sun },
              { id: "system", label: "跟随系统", icon: Monitor },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={cx("theme-option", theme === id && "active")}
              onClick={() => setTheme(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <span className="section-icon">
            <Download size={16} />
          </span>
          <div>
            <h2>下载</h2>
            <p>连接数越多不一定越快，8 线程通常是最佳平衡点。</p>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>默认保存位置</label>
            <p>新任务默认保存到这个文件夹</p>
          </div>
          <div className="setting-control wide">
            <div className="input-with-button">
              <input
                value={settings.saveDir}
                onChange={(event) => update({ saveDir: event.target.value })}
                spellCheck={false}
              />
              <button className="input-button" onClick={pickDir} title="选择文件夹">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>最大同时下载</label>
            <p>超出数量的任务会自动排队，不会偷偷抢带宽</p>
          </div>
          <div className="setting-control">
            <div className="stepper">
              <button
                onClick={() => update({ maxActive: Math.max(1, settings.maxActive - 1) })}
                aria-label="减少"
              >
                −
              </button>
              <span>{settings.maxActive}</span>
              <button
                onClick={() => update({ maxActive: Math.min(8, settings.maxActive + 1) })}
                aria-label="增加"
              >
                +
              </button>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>
              <Gauge size={13} /> 每任务连接数
            </label>
            <p>服务器支持 Range 时会拆成多个并行分片</p>
          </div>
          <div className="setting-control wide">
            <div className="range-row">
              <input
                type="range"
                min={1}
                max={16}
                value={settings.connections}
                onChange={(event) => update({ connections: Number(event.target.value) })}
                className="slider"
                style={{ "--fill": `${((settings.connections - 1) / 15) * 100}%` } as CSSProperties}
              />
              <span className="range-value">{settings.connections}</span>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>全局限速</label>
            <p>跨所有任务共享的带宽上限，随时可改</p>
          </div>
          <div className="setting-control">
            <div className="select-shell">
              <select
                value={settings.globalSpeedLimit ?? "0"}
                onChange={(event) =>
                  update({
                    globalSpeedLimit:
                      event.target.value === "0" ? null : Number(event.target.value),
                  })
                }
              >
                {LIMITS.map((option) => (
                  <option key={String(option.value)} value={option.value ?? "0"}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>
              <Globe size={13} /> 代理
            </label>
            <p>支持 http / https / socks，例如 http://127.0.0.1:7890</p>
          </div>
          <div className="setting-control wide">
            <input
              value={settings.proxy ?? ""}
              onChange={(event) => update({ proxy: event.target.value.trim() || null })}
              placeholder="留空则直连"
              spellCheck={false}
            />
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <span className="section-icon">
            <Film size={16} />
          </span>
          <div>
            <h2>视频下载</h2>
            <p>使用 yt-dlp 解析站点视频，ffmpeg 用于合并音视频。</p>
          </div>
          <button
            className="mini-refresh install"
            onClick={() => void install()}
            disabled={installing || !isTauri}
            title="自动下载 yt-dlp 与 ffmpeg 到本地工具目录"
          >
            {installing ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Download size={13} />
            )}
            {installing ? "安装中" : "一键安装"}
          </button>
          <button className="mini-refresh" onClick={() => void refreshInfo()} title="重新检测">
            <RefreshCw size={13} className={checking ? "spin" : ""} />
            检测
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>yt-dlp 路径</label>
            <p>
              {info ? (
                info.ytDlpAvailable ? (
                  <span className="check-ok">已检测到可执行文件</span>
                ) : (
                  <span className="check-bad">未找到，请安装或填写完整路径</span>
                )
              ) : (
                "留空或填写 yt-dlp / yt-dlp.exe"
              )}
            </p>
          </div>
          <div className="setting-control wide">
            <div className="input-with-button">
              <input
                value={settings.ytDlpPath}
                onChange={(event) => update({ ytDlpPath: event.target.value })}
                spellCheck={false}
                placeholder="yt-dlp.exe"
              />
              <button className="input-button" onClick={pickYtDlp} title="选择可执行文件">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>ffmpeg 路径</label>
            <p>
              {info ? (
                info.ffmpegAvailable ? (
                  <span className="check-ok">已检测到 ffmpeg</span>
                ) : (
                  <span className="check-bad">未找到，合并高清视频时需要</span>
                )
              ) : (
                "可选，用于合并音视频"
              )}
            </p>
          </div>
          <div className="setting-control wide">
            <div className="input-with-button">
              <input
                value={settings.ffmpegPath ?? ""}
                onChange={(event) =>
                  update({ ffmpegPath: event.target.value.trim() || null })
                }
                placeholder="留空则在 PATH 中查找"
                spellCheck={false}
              />
              <button className="input-button" onClick={pickFfmpeg} title="选择可执行文件">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="tip-card">
          <Sparkles size={15} />
          <div className="tip-body">
            <p>
              {installing
                ? progress
                  ? progress.phase === "extract"
                    ? "正在解压 ffmpeg…"
                    : `正在下载 ${progress.tool}：${formatBytes(
                        progress.downloaded,
                      )}${progress.total ? ` / ${formatBytes(progress.total)}` : ""}`
                  : "正在准备下载…"
                : "点“一键安装”会从官方源下载 yt-dlp 与 ffmpeg 到 FluxDL 的本地工具目录，不需要 winget；也可以手动填写路径后点“检测”。"}
            </p>
            {installing && (
              <div className="tool-progress">
                <div
                  className="tool-progress-bar"
                  style={{
                    width: progress?.total
                      ? `${Math.min(
                          100,
                          (progress.downloaded / progress.total) * 100,
                        )}%`
                      : "35%",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <span className="section-icon">
            <Power size={16} />
          </span>
          <div>
            <h2>使用体验</h2>
            <p>这些开关只影响本机行为，不会上传任何数据。</p>
          </div>
        </div>

        <div className="setting-row inline">
          <div className="setting-copy">
            <label>
              <Clipboard size={13} /> 监听剪贴板链接
            </label>
            <p>复制下载链接时在右下角提示，不自动下载</p>
          </div>
          <Toggle
            checked={settings.clipboardWatch}
            onChange={(next) => update({ clipboardWatch: next })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <label>
              <Globe size={13} /> 浏览器链接捕获
            </label>
            <p>
              安装 Chrome / Edge 扩展后，右键“用 FluxDL 下载”或自动接管浏览器下载；接管范围可在扩展弹窗里按类型和体积过滤（本地端口
              35917）
            </p>
          </div>
          <div className="setting-control">
            <button
              className="ghost-button"
              disabled={!isTauri}
              onClick={async () => {
                try {
                  await backend.openExtensionFolder();
                  pushToast("已打开扩展目录，按下方提示加载到浏览器", "info");
                } catch (error) {
                  pushToast(`打开扩展目录失败：${error}`, "error");
                }
              }}
            >
              <FolderOpen size={14} />
              打开扩展目录
            </button>
          </div>
        </div>

        <div className="tip-card">
          <Globe size={15} />
          <p>
            安装方式：打开 <code>chrome://extensions</code>（Edge 为{" "}
            <code>edge://extensions</code>）→ 开启“开发者模式” → “加载已解压的扩展程序” →
            选择上面打开的文件夹。
          </p>
        </div>

        <div className="setting-row inline">
          <div className="setting-copy">
            <label>关闭窗口时留在托盘</label>
            <p>下载继续在后台进行，从托盘可恢复窗口</p>
          </div>
          <Toggle
            checked={settings.closeToTray}
            onChange={(next) => update({ closeToTray: next })}
          />
        </div>

        <div className="setting-row inline">
          <div className="setting-copy">
            <label>完成后打开文件夹</label>
            <p>只对之后完成的任务生效</p>
          </div>
          <Toggle
            checked={settings.openFolderAfter}
            onChange={(next) => update({ openFolderAfter: next })}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <span className="section-icon">
            <Info size={16} />
          </span>
          <div>
            <h2>关于 FluxDL</h2>
            <p>一个自己写的、没有广告的下载器。</p>
          </div>
        </div>
        <div className="about-grid">
          <div className="about-item">
            <span>应用版本</span>
            <strong>0.1.0</strong>
          </div>
          <div className="about-item">
            <span>引擎版本</span>
            <strong>{info?.version ?? "—"}</strong>
          </div>
          <div className="about-item">
            <span>运行平台</span>
            <strong>{info?.os ?? (isTauri ? "—" : "browser preview")}</strong>
          </div>
          <div className="about-item">
            <span>下载目录</span>
            <strong title={settings.saveDir}>{settings.saveDir}</strong>
          </div>
        </div>
        <div className="about-actions">
          <button className="ghost-button" onClick={() => backend.openPath(settings.saveDir)}>
            <FolderOpen size={14} />
            打开下载目录
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              pushToast(
                `当前引擎 ${info?.version ?? "0.1.0"} · 全局限速 ${settings.globalSpeedLimit ? formatSpeed(settings.globalSpeedLimit) : "关闭"}`,
                "info",
              );
            }}
          >
            <HardDrive size={14} />
            引擎状态
          </button>
        </div>
      </section>

      <footer className="settings-footer">
        <span>FluxDL · 私人使用版本</span>
        <span>不做会员，不做限速套路。</span>
      </footer>
    </div>
  );
}
