import { formatBytes } from "../lib/format";
import type { HubListing, RemoteZipListing, UrlProbeInfo } from "../lib/types";

interface HubAndZipPickerProps {
  singleUrl: string | null;
  urlCount: number;
  canResolveHub: boolean;
  looksLikeZip: boolean;
  probing: boolean;
  probeInfo: UrlProbeInfo | null;
  customFilename: string;
  onCustomFilenameChange: (val: string) => void;
  resolvingHub: boolean;
  grabbingPage: boolean;
  loadingZip: boolean;
  submitting: boolean;
  hubListing: HubListing | null;
  hubSelected: ReadonlySet<string>;
  remoteZip: RemoteZipListing | null;
  zipSelected: ReadonlySet<string>;
  onRunProbe: () => void;
  onRunResolveHub: () => void;
  onRunGrabPage: () => void;
  onRunListRemoteZip: () => void;
  onToggleHubAll: () => void;
  onToggleHubItem: (path: string) => void;
  onToggleZipItem: (name: string) => void;
  onExtractSelectedZip: () => void;
}

/**
 * 新建下载弹窗的智能辅助面板：
 * - 单链文件信息极速探测与文件名修改
 * - HuggingFace / ModelScope / GitHub Release / 网页抓链文件勾选器
 * - 远程 ZIP 在线目录预览与按需提取
 */
export function HubAndZipPicker({
  singleUrl,
  urlCount,
  canResolveHub,
  looksLikeZip,
  probing,
  probeInfo,
  customFilename,
  onCustomFilenameChange,
  resolvingHub,
  grabbingPage,
  loadingZip,
  submitting,
  hubListing,
  hubSelected,
  remoteZip,
  zipSelected,
  onRunProbe,
  onRunResolveHub,
  onRunGrabPage,
  onRunListRemoteZip,
  onToggleHubAll,
  onToggleHubItem,
  onToggleZipItem,
  onExtractSelectedZip,
}: HubAndZipPickerProps) {
  return (
    <>
      {singleUrl && (
        <div className="modal-probe-bar">
          {canResolveHub ? (
            <button
              type="button"
              className="drawer-tool-btn primary"
              disabled={resolvingHub}
              onClick={onRunResolveHub}
            >
              {resolvingHub ? "正在拉取文件列表…" : "解析模型仓库 / Release 文件列表"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="drawer-tool-btn"
                disabled={probing}
                onClick={onRunProbe}
              >
                {probing ? "探测中…" : "探测文件信息"}
              </button>
              <button
                type="button"
                className="drawer-tool-btn"
                disabled={grabbingPage}
                onClick={onRunGrabPage}
              >
                {grabbingPage ? "抓取中…" : "抓取网页链接"}
              </button>
              {looksLikeZip && (
                <button
                  type="button"
                  className="drawer-tool-btn primary"
                  disabled={loadingZip}
                  onClick={onRunListRemoteZip}
                >
                  {loadingZip ? "读取目录…" : "在线查看 ZIP 内容"}
                </button>
              )}
            </>
          )}
          {probeInfo && (
            <span className="modal-probe-meta">
              {probeInfo.totalBytes > 0 ? formatBytes(probeInfo.totalBytes) : "未知大小"}
              {" · "}
              {probeInfo.resumable ? "支持续传" : "单流"}
            </span>
          )}
        </div>
      )}

      {probeInfo && urlCount === 1 && (
        <div className="modal-probe-card">
          <label>保存文件名（探测结果，可直接修改）</label>
          <input
            className="drawer-tool-input mono"
            value={customFilename}
            onChange={(e) => onCustomFilenameChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}

      {remoteZip && remoteZip.entries.length > 0 && (
        <div className="hub-picker">
          <div className="hub-picker-head">
            <span>
              远程 ZIP 预览（{formatBytes(remoteZip.totalSize)} · 已选 {zipSelected.size}/{remoteZip.entries.length}）
            </span>
            <button
              type="button"
              className="drawer-tool-btn primary"
              disabled={zipSelected.size === 0 || submitting}
              onClick={onExtractSelectedZip}
            >
              {submitting ? "提取中…" : `仅提取所选 (${zipSelected.size})`}
            </button>
          </div>
          <div className="hub-picker-list">
            {remoteZip.entries.map((entry) => (
              <label className="hub-file-row" key={entry.name}>
                <input
                  type="checkbox"
                  checked={zipSelected.has(entry.name)}
                  onChange={() => onToggleZipItem(entry.name)}
                />
                <span className="hub-file-name mono" title={entry.name}>
                  {entry.name}
                </span>
                <span className="hub-file-size">
                  {formatBytes(entry.uncompressedSize)}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {hubListing && hubListing.files.length > 0 && (
        <div className="hub-picker">
          <div className="hub-picker-head">
            <span>
              {hubListing.source} · {hubListing.title}（已选 {hubSelected.size}/{hubListing.files.length}）
            </span>
            <button
              type="button"
              className="mini-button"
              onClick={onToggleHubAll}
            >
              {hubSelected.size === hubListing.files.length ? "全不选" : "全选"}
            </button>
          </div>
          <div className="hub-picker-list">
            {hubListing.files.map((file) => (
              <label className="hub-file-row" key={file.path}>
                <input
                  type="checkbox"
                  checked={hubSelected.has(file.path)}
                  onChange={() => onToggleHubItem(file.path)}
                />
                <span className="hub-file-name mono" title={file.path}>
                  {file.filename}
                </span>
                {file.sha256 && (
                  <span className="hub-sha-tag" title={file.sha256}>
                    SHA256
                  </span>
                )}
                <span className="hub-file-size">
                  {file.size > 0 ? formatBytes(file.size) : "—"}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
