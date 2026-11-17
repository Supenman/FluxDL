/**
 * 主题预设与自定义强调色。
 * 设计约束（对应方案 3.6）：
 * - 只覆盖品牌原值 --p-primary / --p-primary-hover / --p-primary-active，
 *   语义 token（--accent 等）仍引用这些原值，明暗两套 WCAG AA 修正不动。
 * - 导入采用白名单 + hex 校验，避免任意 CSS 注入。
 */

export interface AccentPreset {
  id: string;
  label: string;
  swatch: string;
  primary: string;
  hover: string;
  active: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "classic", label: "经典蓝", swatch: "#286EDC", primary: "#286EDC", hover: "#4B88E8", active: "#1C56B5" },
  { id: "graphite", label: "石墨青", swatch: "#0F766E", primary: "#0F766E", hover: "#14918A", active: "#0B5C56" },
  { id: "indigo", label: "靛紫", swatch: "#6D28D9", primary: "#6D28D9", hover: "#8557E0", active: "#5622AF" },
];

export interface AccentColors {
  primary: string;
  hover: string;
  active: string;
}

const STORAGE_KEY = "fluxdl:accent";
const HEX = /^#[0-9a-fA-F]{6}$/;

export function readAccent(): AccentColors | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (HEX.test(obj.primary) && HEX.test(obj.hover) && HEX.test(obj.active)) {
      return { primary: obj.primary, hover: obj.hover, active: obj.active };
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveAccent(colors: AccentColors | null): void {
  try {
    if (colors) localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** 解析导入的主题 JSON；只接受白名单键与合法 hex，失败返回错误信息。 */
export function parseAccentJSON(text: string): { ok: true; colors: AccentColors } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是合法的 JSON 文件" };
  }
  if (!obj || typeof obj !== "object") return { ok: false, error: "主题内容格式不正确" };
  const rec = obj as Record<string, unknown>;
  const keys = ["primary", "hover", "active"] as const;
  for (const k of keys) {
    if (typeof rec[k] !== "string" || !HEX.test(rec[k] as string)) {
      return { ok: false, error: `字段 ${k} 必须是 #RRGGBB 格式的颜色` };
    }
  }
  return {
    ok: true,
    colors: {
      primary: rec.primary as string,
      hover: rec.hover as string,
      active: rec.active as string,
    },
  };
}

/** 把强调色写到根元素；传 null 清除覆盖、回退到 CSS 默认。 */
export function applyAccent(colors: AccentColors | null): void {
  const root = document.documentElement;
  if (!colors) {
    root.style.removeProperty("--p-primary");
    root.style.removeProperty("--p-primary-hover");
    root.style.removeProperty("--p-primary-active");
    return;
  }
  root.style.setProperty("--p-primary", colors.primary);
  root.style.setProperty("--p-primary-hover", colors.hover);
  root.style.setProperty("--p-primary-active", colors.active);
}
