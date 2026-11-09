// Generates FluxDL app icons (PNG + ICO) without external image tooling.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(root, { recursive: true });

const SIZE = 1024;
const data = new Uint8ClampedArray(SIZE * SIZE * 4);

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (edge, d) => clamp(0.5 - d / edge);

function roundedRect(x, y, half, radius) {
  const qx = Math.abs(x) - (half - radius);
  const qy = Math.abs(y) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function segment(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

const half = SIZE / 2;
const radius = SIZE * 0.2;

function blend(i, r, g, b, a) {
  if (a <= 0) return;
  const ia = 1 - a;
  data[i] = data[i] * ia + r * a;
  data[i + 1] = data[i + 1] * ia + g * a;
  data[i + 2] = data[i + 2] * ia + b * a;
  data[i + 3] = Math.max(data[i + 3], a * 255);
}

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    const x = px - half;
    const y = py - half;
    const i = (py * SIZE + px) * 4;

    const bgD = roundedRect(x, y, half - 6, radius);
    const bgA = smooth(2.5, bgD);
    if (bgA <= 0) continue;
    const t = clamp((py - (half - half * 0.75)) / (SIZE * 0.95));
    const r = 12 + (6 - 12) * t;
    const g = 24 + (12 - 24) * t;
    const b = 28 + (16 - 28) * t;
    blend(i, r, g, b, bgA);

    // faint inner border
    const innerBorder = smooth(3, Math.abs(roundedRect(x, y, half - 10, radius - 4)) - 0.5);
    blend(i, 120, 255, 214, innerBorder * 0.09);

    // soft radial glow behind the mark
    const glow = Math.hypot(x + 20, y + 60) / (SIZE * 0.5);
    blend(i, 90, 240, 200, clamp(0.10 - glow * 0.10) * bgA);

    // download mark
    const stroke = SIZE * 0.052;
    const dShaft = segment(x, y, 0, -half * 0.5, 0, half * 0.1);
    const dLeft = segment(x, y, 0, half * 0.1, -half * 0.2, -half * 0.05);
    const dRight = segment(x, y, 0, half * 0.1, half * 0.2, -half * 0.05);
    const dBase = segment(x, y, -half * 0.24, half * 0.37, half * 0.24, half * 0.37);
    const markD = Math.min(dShaft, dLeft, dRight, dBase) - stroke / 2;
    const markA = smooth(2.5, markD);
    if (markA > 0) {
      const grad = clamp((y + half * 0.5) / (SIZE * 0.85));
      const cr = 132 + (44 - 132) * grad;
      const cg = 240 + (208 - 240) * grad;
      const cb = 210 + (156 - 210) * grad;
      blend(i, cr, cg, cb, markA);
    }
  }
}

function downsample(src, size, target) {
  const factor = size / target;
  const out = new Uint8ClampedArray(target * target * 4);
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * factor);
      const y0 = Math.floor(y * factor);
      const x1 = Math.floor((x + 1) * factor);
      const y1 = Math.floor((y + 1) * factor);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * size + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += src[i + 3];
          n++;
        }
      }
      const o = (y * target + x) * 4;
      const aa = a / n;
      const w = aa > 0 ? 255 / aa : 0;
      out[o] = r / n * w;
      out[o + 1] = g / n * w;
      out[o + 2] = b / n * w;
      out[o + 3] = aa;
    }
  }
  return out;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = pixels[i];
      raw[o + 1] = pixels[i + 1];
      raw[o + 2] = pixels[i + 2];
      raw[o + 3] = pixels[i + 3];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const variants = [
  [256, "128x128@2x.png"],
  [512, "icon.png"],
  [256, "256x256.png"],
  [128, "128x128.png"],
  [32, "32x32.png"],
];

for (const [size, name] of variants) {
  const pixels = downsample(data, SIZE, size);
  writeFileSync(resolve(root, name), png(pixels, size));
}

const icoPixels = downsample(data, SIZE, 256);
const icoPng = png(icoPixels, 256);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0;
entry[1] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(icoPng.length, 8);
entry.writeUInt32LE(22, 12);
writeFileSync(resolve(root, "icon.ico"), Buffer.concat([header, entry, icoPng]));

console.log("icons written to", root);
