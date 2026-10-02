#!/usr/bin/env node
'use strict';

// 生成应用图标：assets/icon.png（托盘/窗口）与 build/icon.ico（安装包与 exe）。
// 图案是迷你课程卡片：白卡 + 红色强调条 + 三条粉色课程行，颜色取自主题 token。
// 4 倍超采样缩放，纯 Node 手写 PNG / ICO 编码，不依赖任何图形库。
//
// 用法：node tools/make-icon.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const WHITE = [255, 255, 255, 255];
const CARD_EDGE = [226, 226, 236, 255];
const ACCENT = [255, 24, 68, 255];
const ROW = [252, 232, 232, 255];
const SHADOW = [120, 100, 180, 46];
const SCALE = 4;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 画一张 size x size 的图标，返回 RGBA buffer
function renderIcon(size) {
  const canvasSize = size * SCALE;
  const canvas = new Uint8ClampedArray(canvasSize * canvasSize * 4);
  const u = (value) => value * canvasSize;

  function blend(x, y, color, coverage) {
    if (x < 0 || y < 0 || x >= canvasSize || y >= canvasSize || coverage <= 0) return;
    const i = (y * canvasSize + x) * 4;
    const a = (color[3] / 255) * coverage;
    const dstA = canvas[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c += 1) {
      canvas[i + c] = (color[c] * a + canvas[i + c] * dstA * (1 - a)) / outA;
    }
    canvas[i + 3] = outA * 255;
  }

  function roundRect(x, y, w, h, r, color) {
    for (let py = Math.floor(y); py < Math.ceil(y + h); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + w); px += 1) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        if (cx < x || cx > x + w || cy < y || cy > y + h) continue;
        const dx = Math.max(x + r - cx, 0, cx - (x + w - r));
        const dy = Math.max(y + r - cy, 0, cy - (y + h - r));
        const dist = Math.sqrt(dx * dx + dy * dy);
        const coverage = dx === 0 || dy === 0 ? 1 : Math.min(1, Math.max(0, r - dist + 0.5));
        blend(px, py, color, coverage);
      }
    }
  }

  const card = { x: u(0.09), y: u(0.14), w: u(0.82), h: u(0.72), r: u(0.16) };
  roundRect(card.x, card.y + u(0.03), card.w, card.h, card.r, SHADOW);
  roundRect(card.x, card.y, card.w, card.h, card.r, CARD_EDGE);
  roundRect(card.x + u(0.01), card.y + u(0.01), card.w - u(0.02), card.h - u(0.02), card.r - u(0.01), WHITE);
  roundRect(card.x + u(0.07), card.y + u(0.12), u(0.06), card.h - u(0.24), u(0.03), ACCENT);

  const rowX = card.x + u(0.19);
  const rowW = card.w - u(0.28);
  const rowH = u(0.13);
  [0.1, 0.3, 0.5].forEach((offset) => {
    roundRect(rowX, card.y + u(offset + 0.06), rowW, rowH, rowH / 2, ROW);
  });

  const out = Buffer.alloc(size * size * 4);
  for (let oy = 0; oy < size; oy += 1) {
    for (let ox = 0; ox < size; ox += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const i = ((oy * SCALE + sy) * canvasSize + (ox * SCALE + sx)) * 4;
          const alpha = canvas[i + 3] / 255;
          r += canvas[i] * alpha;
          g += canvas[i + 1] * alpha;
          b += canvas[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (oy * size + ox) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (SCALE * SCALE)) * 255);
    }
  }
  return out;
}

// ICO 容器：每个尺寸放一张 PNG（Vista 之后支持 PNG 压缩的图标项）
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]);
}

const root = path.join(__dirname, '..');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map((size) => ({ size, data: encodePng(size, renderIcon(size)) }));

const trayTarget = path.join(root, 'assets', 'icon.png');
fs.mkdirSync(path.dirname(trayTarget), { recursive: true });
fs.writeFileSync(trayTarget, pngs.find((png) => png.size === 32).data);

const icoTarget = path.join(root, 'build', 'icon.ico');
fs.mkdirSync(path.dirname(icoTarget), { recursive: true });
fs.writeFileSync(icoTarget, encodeIco(pngs));

// 同时留一张 256 PNG 方便预览
fs.writeFileSync(
  path.join(root, 'build', 'icon-preview.png'),
  pngs.find((png) => png.size === 256).data,
);

console.log(`已生成 ${trayTarget}（32x32）`);
console.log(`已生成 ${icoTarget}（${icoSizes.join('/')}）`);
