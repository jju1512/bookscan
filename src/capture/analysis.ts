/**
 * 프레임 분석 (SPEC 6장 "프레임 분석"). 순수 계산만 둔다 — worker 와 녹화 재생, 단위 테스트가 함께 쓴다.
 *
 * - 흑백 → 가우시안 블러 후 motion(직전 프레임 대비), change(기준 프레임 대비)를 잰다.
 * - sharpness 는 블러 전 흑백의 라플라시안 분산이다. 블러를 거치면 흔들림과 초점 차이가 줄어 구분이 어렵다.
 * 축소 프레임 하나가 320×240 정도라 OpenCV 없이 직접 계산해도 1~2ms 안에 끝난다.
 */

export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface FrameMetrics {
  motion: number;
  /** 기준 프레임이 없으면 1 (완전히 다름) */
  change: number;
  sharpness: number;
}

/** RGBA → 흑백 (BT.601 근사, 정수 연산) */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayFrame {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
  }
  return { width, height, data: out };
}

/** 5탭 가우시안 블러 [1 4 6 4 1]/16, 가로·세로 분리. 가장자리는 복제 */
export function gaussianBlur5(f: GrayFrame): GrayFrame {
  const { width: w, height: h, data } = f;
  const tmp = new Uint16Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x < 2 ? 0 : x - 2;
      const xm1 = x < 1 ? 0 : x - 1;
      const xp1 = x + 1 >= w ? w - 1 : x + 1;
      const xp2 = x + 2 >= w ? w - 1 : x + 2;
      tmp[row + x] = data[row + xm2]! + 4 * data[row + xm1]! + 6 * data[row + x]! + 4 * data[row + xp1]! + data[row + xp2]!;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym2 = (y < 2 ? 0 : y - 2) * w;
    const ym1 = (y < 1 ? 0 : y - 1) * w;
    const y0 = y * w;
    const yp1 = (y + 1 >= h ? h - 1 : y + 1) * w;
    const yp2 = (y + 2 >= h ? h - 1 : y + 2) * w;
    for (let x = 0; x < w; x++) {
      const v = tmp[ym2 + x]! + 4 * tmp[ym1 + x]! + 6 * tmp[y0 + x]! + 4 * tmp[yp1 + x]! + tmp[yp2 + x]!;
      out[y0 + x] = (v + 128) >> 8;
    }
  }
  return { width: w, height: h, data: out };
}

/** 밝기 차이가 threshold 보다 큰 픽셀의 비율 (0~1). 크기가 다르면 1 */
export function diffRatio(a: GrayFrame, b: GrayFrame, threshold: number): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const n = a.data.length;
  if (n === 0) return 0;
  let count = 0;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < n; i++) {
    const d = da[i]! - db[i]!;
    if (d > threshold || d < -threshold) count++;
  }
  return count / n;
}

/** 라플라시안(4-이웃) 분산. 가장자리 1px 은 뺀다 */
export function laplacianVariance(f: GrayFrame): number {
  const { width: w, height: h, data } = f;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const r = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = r + x;
      const v = data[i - w]! + data[i + w]! + data[i - 1]! + data[i + 1]! - 4 * data[i]!;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** 양선형 보간 크기 변경 (썸네일을 기준 프레임으로 쓸 때) */
export function resizeGray(f: GrayFrame, width: number, height: number): GrayFrame {
  if (f.width === width && f.height === height) return f;
  const out = new Uint8Array(width * height);
  const sx = f.width / width;
  const sy = f.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(f.height - 1, Math.floor(fy));
    const y1 = Math.min(f.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(f.width - 1, Math.floor(fx));
      const x1 = Math.min(f.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = f.data[y0 * f.width + x0]!;
      const b = f.data[y0 * f.width + x1]!;
      const c = f.data[y1 * f.width + x0]!;
      const d = f.data[y1 * f.width + x1]!;
      out[y * width + x] = Math.round((a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy);
    }
  }
  return { width, height, data: out };
}

/**
 * 프레임을 차례로 받아 motion / change / sharpness 를 낸다.
 * 촬영할 때 setReference() 를 불러 "마지막 촬영 순간의 축소 프레임"을 기준으로 삼는다.
 */
export class FrameAnalyzer {
  private prev: GrayFrame | null = null;
  private last: GrayFrame | null = null;
  private reference: GrayFrame | null = null;

  constructor(public pixelDiff: number) {}

  /** gray 는 블러 전 흑백 축소 프레임 */
  analyze(gray: GrayFrame): FrameMetrics {
    const blurred = gaussianBlur5(gray);
    const motion = this.prev ? diffRatio(blurred, this.prev, this.pixelDiff) : 1;
    const change = this.reference ? diffRatio(blurred, this.reference, this.pixelDiff) : 1;
    const sharpness = laplacianVariance(gray);
    this.prev = blurred;
    this.last = blurred;
    return { motion, change, sharpness };
  }

  /** 가장 최근 분석한 프레임을 기준 프레임으로 */
  setReference(): void {
    if (this.last) this.reference = this.last;
  }

  /** 다른 출처(이전 세션의 마지막 촬영 썸네일 등)를 기준 프레임으로. 블러 전 흑백을 넣는다 */
  setReferenceFrom(gray: GrayFrame, width: number, height: number): void {
    this.reference = gaussianBlur5(resizeGray(gray, width, height));
  }

  hasReference(): boolean {
    return this.reference !== null;
  }

  /** 카메라를 다시 열면 직전 프레임은 버린다 (기준 프레임은 남긴다) */
  resetMotion(): void {
    this.prev = null;
  }

  reset(): void {
    this.prev = null;
    this.last = null;
    this.reference = null;
  }
}
