// FluxDL 图标生成器 —— 纯 Node、零第三方依赖，Windows / macOS / Linux 均可运行。
//
// 单一几何真源是本文件顶部的 MARK 定义：既写出 public/brand/*.svg，
// 也直接光栅化为 src-tauri/icons/* 与 browser-extension/icons/* 的 PNG/ICO。
// 这样不会再出现「脚本画薄荷绿箭头 / 仓库里存纯蓝方块」的资产脱节。
//
// 图形：飘带气流（两条月牙弧）+ 下载箭头 + 底部托盘，落在圆角方块底上。

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = join(ROOT, "public/brand");
const APP_ICONS = join(ROOT, "src-tauri/icons");
const EXT_ICONS = join(ROOT, "browser-extension/icons");

const BG_DARK = "#1A1D23";
const BG_LIGHT = "#FFFFFF";
const FG_WHITE = "#FFFFFF";
const FG_BLUE = "#286EDC";

// ---- 几何（100×100 坐标系） ----
const FILL_PATHS = [
  // 左侧飘带：左下尖细尾 -> 逆时针上绕 -> 竖杆左缘水平截断
  "M15 63 C8 46 19 35 45 34.8 L45 43.2 C27.5 44.5 19.5 52.5 19 60.5 C18 62.3 16.5 63.1 15 63 Z",
  // 右侧飘带：竖杆右缘起 -> 向右上翘 -> 收成尖细月牙尾
  "M55 34.8 C66.5 31 76 24 81 13 C79.5 28.5 70.5 39.5 55 43.2 Z",
];
const STROKE_PATHS = [
  { d: "M50 19 L50 57", w: 8.2 },
  { d: "M35.5 45.5 L50 60.5 L64.5 45.5", w: 8.2 },
  { d: "M26 65.5 L26 70 Q26 75 31 75 L69 75 Q74 75 74 70 L74 65.5", w: 7.6 },
];

const iconSvg = (bg, fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">
  <rect width="100" height="100" rx="23" fill="${bg}"/>
  ${FILL_PATHS.map((d) => `  <path d="${d}" fill="${fg}"/>`).join("\n")}
  ${STROKE_PATHS.map(({ d, w }) => `  <path d="${d}" fill="none" stroke="${fg}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`).join("\n")}
</svg>`;

const markSvg = (fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  ${FILL_PATHS.map((d) => `  <path d="${d}" fill="${fg}"/>`).join("\n")}
  ${STROKE_PATHS.map(({ d, w }) => `  <path d="${d}" stroke="${fg}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`).join("\n")}
</svg>`;

for (const dir of [BRAND, APP_ICONS, EXT_ICONS]) mkdirSync(dir, { recursive: true });
writeFileSync(join(BRAND, "fluxdl-icon-dark.svg"), iconSvg(BG_DARK, FG_WHITE));
writeFileSync(join(BRAND, "fluxdl-icon-blue.svg"), iconSvg(BG_DARK, FG_BLUE));
writeFileSync(join(BRAND, "fluxdl-icon-light.svg"), iconSvg(BG_LIGHT, FG_BLUE));
writeFileSync(join(BRAND, "fluxdl-mark.svg"), markSvg(FG_BLUE));
writeFileSync(join(ROOT, "public/favicon.svg"), iconSvg(BG_DARK, FG_WHITE));

// ---- 路径解析：M / L / C / Q / Z ----
function parsePath(d) {
  const tok = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  const pts = [];
  let i = 0, cur = [0, 0], start = [0, 0];
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    const cmd = tok[i++];
    if (cmd === "M" || cmd === "m") {
      cur = cmd === "M" ? [num(), num()] : [cur[0] + num(), cur[1] + num()];
      start = cur.slice(); pts.push([cur[0], cur[1], true]);
    } else if (cmd === "L" || cmd === "l") {
      cur = cmd === "L" ? [num(), num()] : [cur[0] + num(), cur[1] + num()];
      pts.push([cur[0], cur[1], false]);
    } else if (cmd === "C" || cmd === "c") {
      const a = [num(), num()], b = [num(), num()];
      const e = cmd === "C" ? [num(), num()] : [cur[0] + num(), cur[1] + num()];
      const p0 = cur;
      for (let k = 1; k <= 24; k++) {
        const t = k / 24, u = 1 - t;
        pts.push([u*u*u*p0[0]+3*u*u*t*a[0]+3*u*t*t*b[0]+t*t*t*e[0],
                  u*u*u*p0[1]+3*u*u*t*a[1]+3*u*t*t*b[1]+t*t*t*e[1], false]);
      }
      cur = e;
    } else if (cmd === "Q" || cmd === "q") {
      const a = [num(), num()];
      const e = cmd === "Q" ? [num(), num()] : [cur[0] + num(), cur[1] + num()];
      const p0 = cur;
      for (let k = 1; k <= 20; k++) {
        const t = k / 20, u = 1 - t;
        pts.push([u*u*p0[0]+2*u*t*a[0]+t*t*e[0], u*u*p0[1]+2*u*t*a[1]+t*t*e[1], false]);
      }
      cur = e;
    } else if (cmd === "Z" || cmd === "z") {
      cur = start.slice();
    }
  }
  return pts;
}

const FILLS = FILL_PATHS.map(parsePath);
const STROKES = STROKE_PATHS.map(({ d, w }) => ({ pts: parsePath(d), half: w / 2 }));

function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx-ax, vy = by-ay, wx = px-ax, wy = py-ay;
  const len2 = vx*vx + vy*vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx*vx + wy*vy) / len2)) : 0;
  return Math.hypot(wx - t*vx, wy - t*vy);
}

function fillSigned(px, py, pts) {
  let inside = false, minD = Infinity;
  const segs = [];
  for (let k = 1; k < pts.length; k++) {
    if (pts[k][2]) continue;
    segs.push([pts[k-1][0], pts[k-1][1], pts[k][0], pts[k][1]]);
  }
  segs.push([pts[pts.length-1][0], pts[pts.length-1][1], pts[0][0], pts[0][1]]);
  for (const [ax, ay, bx, by] of segs) {
    if ((ay > py) !== (by > py) && px < ((bx-ax)*(py-ay))/(by-ay) + ax) inside = !inside;
    const d = distToSeg(px, py, ax, ay, bx, by);
    if (d < minD) minD = d;
  }
  return inside ? -minD : minD;
}

function strokeSigned(px, py, stroke) {
  let minD = Infinity;
  const pts = stroke.pts;
  for (let k = 1; k < pts.length; k++) {
    if (pts[k][2]) continue;
    const d = distToSeg(px, py, pts[k-1][0], pts[k-1][1], pts[k][0], pts[k][1]);
    if (d < minD) minD = d;
  }
  return minD - stroke.half;
}

function roundedRectSDF(x, y, half, radius) {
  const qx = Math.abs(x) - (half - radius);
  const qy = Math.abs(y) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i+2), 16));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// signed 距离 -> 覆盖率：内部(负)趋近 1，外部(正)趋近 0
const cover = (edge, d) => clamp(0.5 - d / edge, 0, 1);

function renderMaster(size) {
  const bg = hex(BG_DARK), fg = hex(FG_WHITE);
  const data = new Uint8ClampedArray(size * size * 4);
  const scale = 100 / size, edge = 1.2 * scale, radius = 23;
  for (let py = 0; py < size; py++) {
    const y = (py + 0.5) * scale;
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * scale;
      const i = (py*size + px) * 4;
      const bgA = cover(edge, roundedRectSDF(x-50, y-50, 50-1.2, radius));
      if (bgA <= 0) continue;
      let fgA = 0;
      for (const f of FILLS) fgA = Math.max(fgA, cover(edge, fillSigned(x, y, f)));
      for (const s of STROKES) fgA = Math.max(fgA, cover(edge, strokeSigned(x, y, s)));
      fgA *= bgA;
      data[i]   = fg[0]*fgA + bg[0]*(1-fgA);
      data[i+1] = fg[1]*fgA + bg[1]*(1-fgA);
      data[i+2] = fg[2]*fgA + bg[2]*(1-fgA);
      data[i+3] = bgA * 255;
    }
  }
  return data;
}

function downsample(src, size, target) {
  const factor = size / target;
  const out = new Uint8ClampedArray(target*target*4);
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r=0,g=0,b=0,a=0,n=0;
      const x0=Math.floor(x*factor), x1=Math.max(x0+1, Math.floor((x+1)*factor));
      const y0=Math.floor(y*factor), y1=Math.max(y0+1, Math.floor((y+1)*factor));
      for (let sy=y0; sy<y1 && sy<size; sy++) for (let sx=x0; sx<x1 && sx<size; sx++) {
        const i=(sy*size+sx)*4, al=src[i+3]/255;
        r+=src[i]*al; g+=src[i+1]*al; b+=src[i+2]*al; a+=al; n++;
      }
      const o=(y*target+x)*4;
      if (a>0 && n>0) { out[o]=r/a; out[o+1]=g/a; out[o+2]=b/a; out[o+3]=Math.min(255,(a/n)*255); }
    }
  }
  return out;
}

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xedb88320 ^ (c>>>1) : c>>>1; t[n]=c>>>0; }
  return t;
})();
function crc32(buf){ let c=0xffffffff; for(const v of buf) c=CRC_TABLE[(c^v)&0xff]^(c>>>8); return (c^0xffffffff)>>>0; }
function chunk(type, payload){
  const len=Buffer.alloc(4); len.writeUInt32BE(payload.length);
  const body=Buffer.concat([Buffer.from(type,"ascii"),payload]);
  const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len,body,crc]);
}
function png(rgba, size){
  const raw=Buffer.alloc(size*(size*4+1));
  for(let y=0;y<size;y++){
    const row=y*(size*4+1); raw[row]=0;
    Buffer.from(rgba.buffer, y*size*4, size*4).copy(raw,row+1);
  }
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(size,0); ihdr.writeUInt32BE(size,4);
  ihdr[8]=8; ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk("IHDR",ihdr), chunk("IDAT",deflateSync(raw,{level:9})), chunk("IEND",Buffer.alloc(0))]);
}

// ---- ICO（PNG 帧，Vista+ 支持） ----
function ico(images){
  const header=Buffer.alloc(6);
  header.writeUInt16LE(0,0); header.writeUInt16LE(1,2); header.writeUInt16LE(images.length,4);
  const entries=[]; let offset=6+images.length*16;
  for(const {size,buf} of images){
    const e=Buffer.alloc(16);
    e[0]=size>=256?0:size; e[1]=size>=256?0:size; e[2]=0; e[3]=0;
    e.writeUInt16LE(1,4); e.writeUInt16LE(32,6);
    e.writeUInt32LE(buf.length,8); e.writeUInt32LE(offset,12);
    entries.push(e); offset+=buf.length;
  }
  return Buffer.concat([header,...entries,...images.map(i=>i.buf)]);
}

const MASTER=512;
const master=renderMaster(MASTER);
const cache=new Map();
const at=(s)=>{ if(!cache.has(s)) cache.set(s,png(downsample(master,MASTER,s),s)); return cache.get(s); };

for(const s of [16,32,48,128]) writeFileSync(join(EXT_ICONS,`${s}.png`),at(s));
writeFileSync(join(APP_ICONS,"32x32.png"),at(32));
writeFileSync(join(APP_ICONS,"128x128.png"),at(128));
writeFileSync(join(APP_ICONS,"128x128@2x.png"),at(256));
writeFileSync(join(APP_ICONS,"icon.png"),at(512));
writeFileSync(join(APP_ICONS,"icon.ico"),ico([16,32,48,64,128,256].map(s=>({size:s,buf:at(s)}))));

console.log("图标资产生成完成（纯 Node，零依赖）");
console.log("  SVG 真源: fluxdl-icon-dark/blue/light.svg, fluxdl-mark.svg");
console.log("  app icons: 32x32 / 128x128 / 128x128@2x / icon.png / icon.ico(6 帧)");
console.log("  ext icons: 16 / 32 / 48 / 128");
