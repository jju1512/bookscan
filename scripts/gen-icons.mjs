// PWA 아이콘 PNG 를 만든다. 외부 의존성 없이 node:zlib 만 쓴다.
// 실행: npm run icons  → public/icons/*.png 를 덮어쓴다. 결과 PNG 는 저장소에 커밋한다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x1e, 0x40, 0xaf];
const PAGE = [0xf8, 0xfa, 0xfc];
const TEXT = [0x94, 0xa3, 0xb8];

/** 정규화 좌표(0~1)에서 색을 고른다. scale: 그림이 차지하는 비율 (maskable 은 안전 영역 때문에 작게) */
function shade(x, y, scale) {
  const u = (x - 0.5) / scale + 0.5;
  const v = (y - 0.5) / scale + 0.5;
  // 펼친 책: 왼쪽·오른쪽 페이지, 가운데 책등 틈
  const top = 0.2;
  const bottom = 0.8;
  const inLeft = u >= 0.12 && u <= 0.485 && v >= top && v <= bottom;
  const inRight = u >= 0.515 && u <= 0.88 && v >= top && v <= bottom;
  if (!inLeft && !inRight) return BG;
  // 글자 줄
  const px = inLeft ? (u - 0.12) / 0.365 : (u - 0.515) / 0.365;
  const py = (v - top) / (bottom - top);
  const line = Math.floor(py * 9);
  const inLine = line >= 1 && line <= 7 && (py * 9) % 1 > 0.35 && (py * 9) % 1 < 0.75;
  if (inLine && px > 0.14 && px < (line === 7 ? 0.6 : 0.86)) return TEXT;
  return PAGE;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, scale) {
  const ss = 4; // 가장자리 부드럽게: 픽셀당 4×4 표본
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, scale);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r / (ss * ss));
      raw[o + 1] = Math.round(g / (ss * ss));
      raw[o + 2] = Math.round(b / (ss * ss));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = new URL('../public/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.72], // maskable 안전 영역(지름 80%) 안에 들어가게
];
for (const [name, size, scale] of targets) {
  writeFileSync(new URL(name, outDir), png(size, scale));
  console.log(`public/icons/${name} (${size}px)`);
}
