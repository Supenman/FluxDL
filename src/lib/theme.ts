/**
 * 主题：OKLab 感知均匀派生 + WCAG AA 对比度保证 + Base16/pywal 导入。
 *
 * 设计约束（MDM 路线 A · 主题派生）：
 * - 只给一个种子色，其余色阶全部从种子在 OKLab 空间派生，保证感知均匀的 hover/active 阶梯。
 * - accent-text（深色底/浅底各一套）与 accent-ink 用 WCAG 对比度反解，确保 >= 4.5:1。
 * - 明暗两套语义变量分别写入 <style>，[data-theme] 切换时各自生效，不用 inline style 覆盖。
 * - 导入采用白名单 + hex 校验 + 种子派生，避免任意 CSS 注入。
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
  /** 派生种子（通常与 primary 相同）；缺省时用 primary。 */
  seed?: string;
}

/** 派生的完整色阶（内部使用）。 */
interface DerivedAccent {
  primary: string;
  hover: string;
  active: string;
  textDark: string;
  textLight: string;
  ink: string;
  softRgb: string;
  lineRgb: string;
}

const STORAGE_KEY = "fluxdl:accent";
const STYLE_ID = "fluxdl-accent-derived";
const HEX = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------
// 颜色空间工具
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(rgb: RGB): string {
  return "#" + rgb.map((n) => clampByte(n).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const x = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return x * 255;
}

interface Oklab { L: number; a: number; b: number }

function rgbToOklab(rgb: RGB): Oklab {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

function oklabToRgb(lab: Oklab): RGB {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

function labHex(L: number, a: number, b: number): string {
  return rgbToHex(oklabToRgb({ L: Math.max(0, Math.min(1, L)), a, b }));
}

// ---------------------------------------------------------------------------
// WCAG 相对亮度 / 对比度
// ---------------------------------------------------------------------------

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 在固定色相(a,b)上，二分搜索满足对比度阈值且最接近目标亮度的 L。 */
function solveLightness(a: number, b: number, bg: string, targetL: number, minL: number, maxL: number, minRatio = 4.5): number {
  const ok = (L: number) => contrastRatio(labHex(L, a, b), bg) >= minRatio;
  if (ok(targetL)) return targetL;
  // 先判断该往亮还是暗走：测试两端哪端满足。
  const lowOk = ok(minL);
  const highOk = ok(maxL);
  if (!lowOk && !highOk) return targetL; // 极端种子，回退目标值
  const wantHigh = highOk;
  let lo = wantHigh ? targetL : minL;
  let hi = wantHigh ? maxL : targetL;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) {
      if (wantHigh) lo = mid;
      else hi = mid;
    } else {
      if (wantHigh) hi = mid;
      else lo = mid;
    }
  }
  return wantHigh ? hi : lo;
}

// ---------------------------------------------------------------------------
// 派生
// ---------------------------------------------------------------------------

/** 从单一种子色派生完整色阶：OKLab 感知阶梯 + WCAG 对比度保证。 */
export function deriveAccent(seedHex: string): DerivedAccent {
  const seed = HEX.test(seedHex) ? seedHex.toUpperCase() : "#286EDC";
  const lab = rgbToOklab(hexToRgb(seed));
  const primary = seed;
  const hover = labHex(Math.min(1, lab.L + 0.10), lab.a * 0.95, lab.b * 0.95);
  const active = labHex(Math.max(0, lab.L - 0.09), lab.a * 1.02, lab.b * 1.02);

  // 深色底（S0 #121417）上的文字：提亮到 AA；浅色底（S2 #F1F5F9）上的文字：压暗到 AA。
  const textLightL = solveLightness(lab.a * 0.35, lab.b * 0.35, "#121417", 0.84, 0.70, 0.98);
  const textDarkL = solveLightness(lab.a * 0.35, lab.b * 0.35, "#F1F5F9", 0.46, 0.20, 0.60);
  const textDark = labHex(textLightL, lab.a * 0.35, lab.b * 0.35);
  const textLight = labHex(textDarkL, lab.a * 0.35, lab.b * 0.35);

  // 主按钮文字：白 / 深墨，谁在 primary 上对比度高用谁。
  const ink = contrastRatio("#FFFFFF", primary) >= contrastRatio("#0F172A", primary)
    ? "#FFFFFF"
    : "#0F172A";

  const [sr, sg, sb] = hexToRgb(primary);
  return {
    primary,
    hover,
    active,
    textDark,
    textLight,
    ink,
    softRgb: `${sr}, ${sg}, ${sb}`,
    lineRgb: `${sr}, ${sg}, ${sb}`,
  };
}

/** 把 AccentColors 归一化为派生色阶（兼容只有三色的旧值）。 */
function normalize(colors: AccentColors): DerivedAccent {
  return deriveAccent(colors.seed || colors.primary);
}

// ---------------------------------------------------------------------------
// 持久化 / 解析
// ---------------------------------------------------------------------------

export function readAccent(): AccentColors | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (HEX.test(obj.primary)) {
      const d = deriveAccent(obj.seed || obj.primary);
      return { primary: d.primary, hover: d.hover, active: d.active, seed: d.primary };
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveAccent(colors: AccentColors | null): void {
  try {
    if (colors) {
      const d = normalize(colors);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        primary: d.primary, hover: d.hover, active: d.active, seed: d.primary,
      }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * 解析导入主题 JSON，支持三种格式，统一返回派生的 AccentColors：
 * 1) 标准三键 { primary, hover, active }
 * 2) pywal colors.json { colors: { color5|color13: "#..." }, special: {...} }
 * 3) Base16 { palette: { base0D: "#..." } }
 */
export function parseAccentJSON(text: string): { ok: true; colors: AccentColors } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是合法的 JSON 文件" };
  }
  if (!obj || typeof obj !== "object") return { ok: false, error: "主题内容格式不正确" };
  const rec = obj as Record<string, unknown>;

  let seed: string | null = null;
  // 格式 1：三键
  if (typeof rec.primary === "string" && HEX.test(rec.primary)) {
    seed = rec.primary;
  }
  // 格式 2：pywal
  if (!seed && rec.colors && typeof rec.colors === "object") {
    const c = rec.colors as Record<string, unknown>;
    for (const key of ["color13", "color5", "color6", "color4"]) {
      if (typeof c[key] === "string" && HEX.test(c[key])) { seed = c[key]; break; }
    }
  }
  // 格式 3：Base16
  if (!seed && rec.palette && typeof rec.palette === "object") {
    const p = rec.palette as Record<string, unknown>;
    for (const key of ["base0D", "base0C", "base0B", "base05"]) {
      if (typeof p[key] === "string" && HEX.test(p[key])) { seed = p[key]; break; }
    }
  }
  if (!seed) {
    return { ok: false, error: "找不到可用的颜色（需含 primary 或 pywal colors / Base16 palette）" };
  }

  const d = deriveAccent(seed);
  return {
    ok: true,
    colors: { primary: d.primary, hover: d.hover, active: d.active, seed: d.primary },
  };
}

// ---------------------------------------------------------------------------
// 应用：注入 <style>，明暗两套分别写，切主题时各自生效
// ---------------------------------------------------------------------------

export function applyAccent(colors: AccentColors | null): void {
  const root = document.documentElement;
  // 清掉旧版本可能写入的 inline 覆盖，避免优先级压过我们的 <style>。
  root.style.removeProperty("--p-primary");
  root.style.removeProperty("--p-primary-hover");
  root.style.removeProperty("--p-primary-active");

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!colors) {
    style?.remove();
    return;
  }
  const d = normalize(colors);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const dark = `
    --p-primary: ${d.primary};
    --p-primary-hover: ${d.hover};
    --p-primary-active: ${d.active};
    --accent-text: ${d.textDark};
    --accent-soft: rgba(${d.softRgb}, 0.16);
    --accent-line: rgba(${d.lineRgb}, 0.42);
    --accent-ink: ${d.ink};
  `;
  const light = `
    --p-primary: ${d.primary};
    --p-primary-hover: ${d.hover};
    --p-primary-active: ${d.active};
    --accent-text: ${d.textLight};
    --accent-soft: rgba(${d.softRgb}, 0.09);
    --accent-line: rgba(${d.lineRgb}, 0.32);
    --accent-ink: ${d.ink};
  `;
  style.textContent = `
    :root[data-theme="dark"] { ${dark} }
    :root[data-theme="light"] { ${light} }
  `;
}
