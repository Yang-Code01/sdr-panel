'use strict';
// 生成托盘/应用图标：手写 PNG（zlib 足够，不引依赖）。太阳图形，4×4 超采样抗锯齿。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 归一化坐标下的太阳：实心圆 + 8 根短线
function sunAlpha(x, y) {
  const cx = 0.5;
  const cy = 0.5;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  if (r <= 0.19) return 1;
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const offset = Math.abs(((ang % step) + step) % step - step / 2);
  const rayWidth = 0.055;
  if (r > 0.27 && r < 0.41) {
    const lateral = Math.abs(Math.sin(offset) * r);
    if (lateral < rayWidth) return 1;
  }
  return 0;
}

function render(size, color) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size;
          const ny = (y + (sy + 0.5) / ss) / size;
          acc += sunAlpha(nx, ny);
        }
      }
      const a = Math.round((acc / (ss * ss)) * 255);
      const o = (y * size + x) * 4;
      buf[o] = color[0];
      buf[o + 1] = color[1];
      buf[o + 2] = color[2];
      buf[o + 3] = a;
    }
  }
  return encodePng(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
// 深色任务栏用白字，浅色任务栏（Windows 亮色主题）用近黑
fs.writeFileSync(path.join(outDir, 'tray-light.png'), render(32, [28, 28, 30])); // 亮色主题 → 深色图标
fs.writeFileSync(path.join(outDir, 'tray-dark.png'), render(32, [242, 242, 247])); // 深色主题 → 白色图标
fs.writeFileSync(path.join(outDir, 'icon-256.png'), render(256, [242, 242, 247]));
console.log('icons written to', outDir);
