/**
 * 합성 테스트 데이터용 작은 래스터 도구 모음.
 *
 * - Node 가 타입만 지우고 바로 실행할 수 있어야 한다: enum·namespace·parameter property 를 쓰지 않는다.
 * - 좌표계: 픽셀 (i, j) 는 [i, i+1) × [j, j+1) 를 덮고, 중심은 (i+0.5, j+0.5) 이다. 모든 연속 좌표가 이 규칙을 따른다.
 * - 난수는 시드 고정 PRNG 만 쓴다. 같은 시드면 같은 바이트가 나온다.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Rgb = readonly [number, number, number];
export type Rng = () => number;

/** 연속 좌표의 점 */
export interface Pt {
  x: number;
  y: number;
}

// ───────────────────────── 난수 ─────────────────────────

/** mulberry32: 32비트 시드 → [0,1) 난수열 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 여러 정수를 섞어 하나의 시드로 만든다 (페이지·프레임마다 독립된 난수열을 얻으려는 용도) */
export function mixSeed(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** 평균 0, 표준편차 약 1 인 가우시안 비슷한 값 (균등분포 4개의 합, 중심극한정리) */
export function gaussLike(rng: Rng): number {
  return (rng() + rng() + rng() + rng() - 2) * 1.7320508;
}

// ───────────────────────── 이미지 만들기 ─────────────────────────

export function createImage(width: number, height: number, color: Rgb = [0, 0, 0]): RgbaImage {
  const img: RgbaImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  fill(img, color);
  return img;
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** 이미지 전체를 불투명한 한 색으로 채운다 */
export function fill(img: RgbaImage, color: Rgb): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = color[0];
    d[i + 1] = color[1];
    d[i + 2] = color[2];
    d[i + 3] = 255;
  }
}

/** (x, y) 정수 픽셀에 색을 알파 합성한다. 범위 밖이면 무시한다 */
export function blendPixel(img: RgbaImage, x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  if (a >= 1) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
    return;
  }
  const da = d[i + 3]! / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  const k = a / oa;
  d[i] = d[i]! + (r - d[i]!) * k;
  d[i + 1] = d[i + 1]! + (g - d[i + 1]!) * k;
  d[i + 2] = d[i + 2]! + (b - d[i + 2]!) * k;
  d[i + 3] = oa * 255;
}

// ───────────────────────── 도형 (안티앨리어싱) ─────────────────────────

/** 실수 좌표 사각형. 가장자리 픽셀은 덮인 면적 비율만큼 섞는다 */
export function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    const cy = Math.min(py + 1, y + h) - Math.max(py, y);
    if (cy <= 0) continue;
    for (let px = x0; px < x1; px++) {
      const cx = Math.min(px + 1, x + w) - Math.max(px, x);
      if (cx <= 0) continue;
      blendPixel(img, px, py, color[0], color[1], color[2], alpha * Math.min(1, cx) * Math.min(1, cy));
    }
  }
}

/** 부호 있는 거리(px, 안쪽이 음수)를 덮임 비율 0..1 로 바꾼다 */
export function coverageOf(signedDistance: number): number {
  const c = 0.5 - signedDistance;
  return c <= 0 ? 0 : c >= 1 ? 1 : c;
}

/** 둥근 사각형의 부호 있는 거리 */
export function roundRectSdf(px: number, py: number, x: number, y: number, w: number, h: number, r: number): number {
  const rr = Math.min(r, w / 2, h / 2);
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - rr);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - rr);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
}

/** 타원의 부호 있는 거리 (근사: 단축 길이로 환산한 정규화 거리) */
export function ellipseSdf(px: number, py: number, cx: number, cy: number, rx: number, ry: number): number {
  const nx = (px - cx) / rx;
  const ny = (py - cy) / ry;
  return (Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
}

/** 선분 a→b 에서 반지름 r 만큼 부푼 캡슐(둥근 막대)의 부호 있는 거리 */
export function capsuleSdf(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t)) - r;
}

export type Painter = (x: number, y: number, signedDistance: number) => Rgb;

/**
 * 거리장(sdf)으로 정의한 도형을 칠한다. 경계 픽셀은 거리로 안티앨리어싱한다.
 * bbox 는 확인할 범위(실수), color 는 고정색이거나 위치별 색을 돌려주는 함수.
 */
export function fillSdf(
  img: RgbaImage,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  sdf: (x: number, y: number) => number,
  color: Rgb | Painter,
  alpha = 1,
): void {
  const x0 = Math.max(0, Math.floor(bbox.x0));
  const y0 = Math.max(0, Math.floor(bbox.y0));
  const x1 = Math.min(img.width, Math.ceil(bbox.x1));
  const y1 = Math.min(img.height, Math.ceil(bbox.y1));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const d = sdf(px + 0.5, py + 0.5);
      const cov = coverageOf(d);
      if (cov <= 0) continue;
      const c = typeof color === 'function' ? color(px + 0.5, py + 0.5, d) : color;
      blendPixel(img, px, py, c[0], c[1], c[2], alpha * cov);
    }
  }
}

export function fillRoundRect(
  img: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: Rgb | Painter,
  alpha = 1,
): void {
  fillSdf(img, { x0: x - 1, y0: y - 1, x1: x + w + 1, y1: y + h + 1 }, (px, py) => roundRectSdf(px, py, x, y, w, h, radius), color, alpha);
}

export function fillEllipse(
  img: RgbaImage,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: Rgb | Painter,
  alpha = 1,
): void {
  fillSdf(img, { x0: cx - rx - 1, y0: cy - ry - 1, x1: cx + rx + 1, y1: cy + ry + 1 }, (px, py) => ellipseSdf(px, py, cx, cy, rx, ry), color, alpha);
}

export function fillCapsule(
  img: RgbaImage,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
  color: Rgb | Painter,
  alpha = 1,
): void {
  fillSdf(
    img,
    { x0: Math.min(ax, bx) - radius - 1, y0: Math.min(ay, by) - radius - 1, x1: Math.max(ax, bx) + radius + 1, y1: Math.max(ay, by) + radius + 1 },
    (px, py) => capsuleSdf(px, py, ax, ay, bx, by, radius),
    color,
    alpha,
  );
}

// ───────────────────────── 합성·샘플링 ─────────────────────────

/** src 를 dst 의 (dx, dy) 정수 위치에 알파 합성한다. opacity 는 src 알파에 곱한다 */
export function compositeOver(dst: RgbaImage, src: RgbaImage, dx: number, dy: number, opacity = 1): void {
  for (let sy = 0; sy < src.height; sy++) {
    const y = sy + dy;
    if (y < 0 || y >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const x = sx + dx;
      if (x < 0 || x >= dst.width) continue;
      const i = (sy * src.width + sx) * 4;
      blendPixel(dst, x, y, src.data[i]!, src.data[i + 1]!, src.data[i + 2]!, (src.data[i + 3]! / 255) * opacity);
    }
  }
}

/**
 * 양선형 샘플링. (x, y) 는 연속 좌표(픽셀 중심이 +0.5)이고 범위 밖은 가장자리 색을 쓴다.
 * 결과 RGBA(0..255 실수)를 out[0..3] 에 쓴다.
 */
export function sampleBilinear(img: RgbaImage, x: number, y: number, out: number[] | Float64Array): void {
  const fx = x - 0.5;
  const fy = y - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  const mx = img.width - 1;
  const my = img.height - 1;
  x0 = x0 < 0 ? 0 : x0 > mx ? mx : x0;
  x1 = x1 < 0 ? 0 : x1 > mx ? mx : x1;
  y0 = y0 < 0 ? 0 : y0 > my ? my : y0;
  y1 = y1 < 0 ? 0 : y1 > my ? my : y1;
  const d = img.data;
  const w = img.width;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  for (let c = 0; c < 4; c++) {
    out[c] = d[i00 + c]! * w00 + d[i10 + c]! * w10 + d[i01 + c]! * w01 + d[i11 + c]! * w11;
  }
}

/**
 * 밝기 노이즈를 더한다. 정수 값을 세 채널에 똑같이 더해 색조를 바꾸지 않고, PNG 필터·deflate 가 채널 간 반복을 잡아 크기도 덜 늘어난다.
 * rect 를 주면 그 영역만, 없으면 전체. sigma 는 표준편차(0..255 단위).
 */
export function addNoise(
  img: RgbaImage,
  rng: Rng,
  sigma: number,
  rect?: { x: number; y: number; w: number; h: number },
): void {
  if (sigma <= 0) return;
  const x0 = Math.max(0, rect ? Math.floor(rect.x) : 0);
  const y0 = Math.max(0, rect ? Math.floor(rect.y) : 0);
  const x1 = Math.min(img.width, rect ? Math.ceil(rect.x + rect.w) : img.width);
  const y1 = Math.min(img.height, rect ? Math.ceil(rect.y + rect.h) : img.height);
  const d = img.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const n = Math.round(gaussLike(rng) * sigma);
      d[i] = d[i]! + n;
      d[i + 1] = d[i + 1]! + n;
      d[i + 2] = d[i + 2]! + n;
    }
  }
}

// ───────────────────────── PNG ─────────────────────────

/** RGBA → PNG 바이트. 알파는 쓰지 않는다(전부 불투명으로 보고 RGB 8비트로 저장해 크기를 줄인다) */
export function encodePng(img: RgbaImage): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9 });
}

export function savePng(path: string, img: RgbaImage): number {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = encodePng(img);
  writeFileSync(path, bytes);
  return bytes.byteLength;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

export function loadPng(path: string): RgbaImage {
  return decodePng(readFileSync(path));
}
