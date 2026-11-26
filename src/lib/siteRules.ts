/**
 * 按站点规则配置（参考 MDM Site Rules）：
 * 为特定域名预设连接数、限速、Referer 与 User-Agent，新建任务与批量导入时自动命中。
 * 遵循零凭证边界：仅保存公开传输参数，不存储 Cookie 或鉴权令牌。
 */

export interface SiteRule {
  id: string;
  /** 域名或通配模式，如 `example.com` 或 `*.example.com` */
  pattern: string;
  enabled: boolean;
  /** 连接数（1-32）；null/undefined 表示沿用全局或任务手动设置 */
  connections?: number | null;
  /** 限速（字节/秒）；null/undefined 表示沿用全局或任务手动设置 */
  speedLimit?: number | null;
  referer?: string;
  userAgent?: string;
}

const STORAGE_KEY = "fluxdl.siteRules.v1";

export function normalizePattern(raw: string): string {
  let s = raw.trim().toLowerCase();
  // 允许用户直接粘贴完整 URL，自动抽取主机名
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname.toLowerCase();
    } catch {
      // keep raw
    }
  }
  s = s.replace(/\/.*$/, "").replace(/:\d+$/, "");
  return s;
}

export function readSiteRules(): SiteRule[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SiteRule =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.pattern === "string" &&
        item.pattern.trim().length > 0,
    );
  } catch {
    return [];
  }
}

export function saveSiteRules(rules: SiteRule[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // ignore quota errors
  }
}

export function createSiteRule(input: Omit<SiteRule, "id">): SiteRule {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...input,
    id,
    pattern: normalizePattern(input.pattern),
  };
}

function hostMatchesPattern(host: string, pattern: string): number {
  const h = host.toLowerCase();
  const p = normalizePattern(pattern);
  if (!p) return 0;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    if (!suffix) return 0;
    if (h === suffix || h.endsWith(`.${suffix}`)) {
      return suffix.length + 1;
    }
    return 0;
  }
  if (h === p) return p.length + 1000; // 精确匹配优先于通配
  if (h.endsWith(`.${p}`)) return p.length;
  return 0;
}

/**
 * 根据链接匹配优先级最高的已启用站点规则（精确域名 > 更长后缀通配）。
 */
export function matchSiteRule(
  rawUrl: string,
  rules: SiteRule[] = readSiteRules(),
): SiteRule | null {
  let host = "";
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  let best: SiteRule | null = null;
  let bestScore = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const score = hostMatchesPattern(host, rule.pattern);
    if (score > bestScore) {
      bestScore = score;
      best = rule;
    }
  }
  return best;
}
