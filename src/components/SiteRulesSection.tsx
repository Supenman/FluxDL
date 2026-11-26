import { useState } from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import {
  createSiteRule,
  normalizePattern,
  readSiteRules,
  saveSiteRules,
  type SiteRule,
} from "../lib/siteRules";
import { formatSpeed } from "../lib/format";
import { useStore } from "../store";

export function SiteRulesSection() {
  const pushToast = useStore((s) => s.pushToast);
  const [rules, setRules] = useState<SiteRule[]>(() => readSiteRules());
  const [pattern, setPattern] = useState("");
  const [connections, setConnections] = useState("");
  const [speedLimitMb, setSpeedLimitMb] = useState("");
  const [referer, setReferer] = useState("");
  const [userAgent, setUserAgent] = useState("");

  const persist = (next: SiteRule[]) => {
    setRules(next);
    saveSiteRules(next);
  };

  const addRule = () => {
    const normalized = normalizePattern(pattern);
    if (!normalized) {
      pushToast("请输入有效的域名或通配模式（如 *.example.com）", "error");
      return;
    }
    const connNum = connections.trim() ? Number(connections) : null;
    const connVal =
      connNum !== null && Number.isFinite(connNum) && connNum >= 1 && connNum <= 32
        ? Math.floor(connNum)
        : null;
    const limitNum = speedLimitMb.trim() ? Number(speedLimitMb) : null;
    const limitVal =
      limitNum !== null && Number.isFinite(limitNum) && limitNum > 0
        ? Math.floor(limitNum * 1024 * 1024)
        : null;

    const rule = createSiteRule({
      pattern: normalized,
      enabled: true,
      connections: connVal,
      speedLimit: limitVal,
      referer: referer.trim() || undefined,
      userAgent: userAgent.trim() || undefined,
    });
    persist([rule, ...rules]);
    setPattern("");
    setConnections("");
    setSpeedLimitMb("");
    setReferer("");
    setUserAgent("");
    pushToast(`已添加站点规则：${normalized}`, "success");
  };

  const toggleRule = (id: string) => {
    persist(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  };

  const removeRule = (id: string) => {
    persist(rules.filter((r) => r.id !== id));
    pushToast("已删除站点规则", "success");
  };

  return (
    <section className="settings-section">
      <div className="section-head">
        <span className="section-icon">
          <Globe size={16} />
        </span>
        <div>
          <h2>站点规则</h2>
          <p>按域名预设连接数、限速、Referer 与 User-Agent，新建任务时自动生效</p>
        </div>
      </div>

      <div className="site-rule-form">
        <input
          className="drawer-tool-input mono"
          type="text"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="域名模式，例如 *.github.com 或 cdn.example.com"
        />
        <div className="site-rule-grid">
          <input
            className="drawer-tool-input"
            type="number"
            min={1}
            max={32}
            value={connections}
            onChange={(e) => setConnections(e.target.value)}
            placeholder="连接数 (1-32，可选)"
          />
          <input
            className="drawer-tool-input"
            type="number"
            min={0.1}
            step={0.5}
            value={speedLimitMb}
            onChange={(e) => setSpeedLimitMb(e.target.value)}
            placeholder="限速 MB/s（可选）"
          />
          <input
            className="drawer-tool-input"
            type="text"
            value={referer}
            onChange={(e) => setReferer(e.target.value)}
            placeholder="默认 Referer（可选）"
          />
          <input
            className="drawer-tool-input"
            type="text"
            value={userAgent}
            onChange={(e) => setUserAgent(e.target.value)}
            placeholder="自定义 User-Agent（可选）"
          />
        </div>
        <div>
          <button type="button" className="drawer-tool-btn primary" onClick={addRule}>
            <Plus size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            添加站点规则
          </button>
        </div>
      </div>

      {rules.length > 0 ? (
        <div className="site-rule-list">
          {rules.map((rule) => (
            <div className="site-rule-item" key={rule.id}>
              <div className="site-rule-main">
                <label className="site-rule-toggle">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => toggleRule(rule.id)}
                  />
                  <span className="mono">{rule.pattern}</span>
                </label>
                <span className="site-rule-meta">
                  {[
                    rule.connections ? `${rule.connections} 线程` : null,
                    rule.speedLimit ? `限速 ${formatSpeed(rule.speedLimit)}` : null,
                    rule.referer ? `Referer: ${rule.referer}` : null,
                    rule.userAgent ? "自定义 UA" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "仅匹配标记"}
                </span>
              </div>
              <button
                type="button"
                className="mini-button"
                onClick={() => removeRule(rule.id)}
                title="删除规则"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="drawer-tool-hint" style={{ marginTop: 8 }}>
          暂无站点规则。为限流站点配置较低连接数或固定 Referer 后，无需每次新建任务手动调整。
        </p>
      )}
    </section>
  );
}
