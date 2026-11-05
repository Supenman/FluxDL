import { Search, Download, Clipboard, Plus, X, Inbox } from "lucide-react";
import { useStore } from "../store";
import { extractUrls } from "../lib/format";
import { Logo } from "./Logo";

interface EmptyStateProps {
  mode: "empty" | "search" | "filter";
  query?: string;
}

export function EmptyState({ mode, query }: EmptyStateProps) {
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const setQuery = useStore((s) => s.setQuery);
  const pushToast = useStore((s) => s.pushToast);

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const urls = extractUrls(text);
      if (urls.length) {
        setNewTaskOpen(true, urls.join("\n"));
      } else {
        pushToast("剪贴板里没有可下载的链接", "error");
      }
    } catch {
      pushToast("无法读取剪贴板，请在新建窗口里直接粘贴链接", "error");
    }
  };

  if (mode === "search") {
    return (
      <div className="empty-state compact">
        <div className="empty-icon">
          <Search size={26} />
        </div>
        <h2>没有找到匹配的任务</h2>
        <p>
          没有与 “{query}” 匹配的文件名、链接或域名。
        </p>
        <button className="ghost-button" onClick={() => setQuery("")}>
          <X size={14} />
          清空搜索
        </button>
      </div>
    );
  }

  if (mode === "filter") {
    return (
      <div className="empty-state compact">
        <div className="empty-icon">
          <Inbox size={26} />
        </div>
        <h2>这个分类下还没有任务</h2>
        <p>切换左侧分类，或添加一个新的下载。</p>
        <button className="primary-button" onClick={() => setNewTaskOpen(true)}>
          <Plus size={15} />
          新建下载
        </button>
      </div>
    );
  }

  return (
    <div className="empty-state hero">
      <div className="empty-art">
        <div className="empty-halo" />
        <div className="empty-orbit orbit-one" />
        <div className="empty-orbit orbit-two" />
        <div className="empty-glyph">
          <Logo size={52} />
        </div>
        <span className="speed-line line-one" />
        <span className="speed-line line-two" />
        <span className="speed-line line-three" />
      </div>
      <h2>把链接丢进来，剩下的交给 FluxDL</h2>
      <p>
        多线程下载、断点续传、视频抓取、实时限速。
        <br />
        没有广告，没有弹窗，也没有“高速通道”。
      </p>
      <div className="empty-actions">
        <button className="primary-button large" onClick={() => setNewTaskOpen(true)}>
          <Plus size={16} />
          新建下载
        </button>
        <button className="ghost-button large" onClick={pasteClipboard}>
          <Clipboard size={15} />
          从剪贴板添加
        </button>
      </div>
      <div className="empty-hints">
        <span>
          <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴链接
        </span>
        <span className="hint-dot" />
        <span>拖拽链接或文本文件到窗口</span>
        <span className="hint-dot" />
        <span>
          <Download size={11} /> 浏览器下载也可捕获
        </span>
      </div>
    </div>
  );
}
