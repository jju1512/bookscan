/**
 * 화질 보정 (SPEC 8장): 배경을 흰색으로 맞추고 대비를 조정한다. 선택하면 적응형 임계값 흑백으로 바꾼다.
 * 배경 추정: 1/4 로 줄인 영상을 팽창(dilate, 밝은 값 퍼뜨리기)해 글자를 지우고 흐린 뒤 원래 크기로 → 원본 ÷ 배경.
 * 그다음 밝기 하위 1%·상위 99% 를 0·255 로 늘린다.
 */
import { del, matToRaster, rasterToMat, type CV, type Raster } from '../raster';

export interface EnhanceOptions {
  binarize?: boolean;
}

export interface EnhanceResult {
  raster: Raster;
  /** 보정 전후 배경 밝기 중앙값 */
  backgroundBefore: number;
  backgroundAfter: number;
}

export function enhancePage(cv: CV, src: Raster, opts: EnhanceOptions = {}): EnhanceResult {
  const W = src.width;
  const H = src.height;
  const rgba = rasterToMat(cv, src);
  const rgb = new cv.Mat();
  const small = new cv.Mat();
  const bg = new cv.Mat();
  const bgFull = new cv.Mat();
  const norm = new cv.Mat();
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const before = medianGray(rgb.data as Uint8Array, 3);
    const sw = Math.max(8, Math.round(W / 4));
    const sh = Math.max(8, Math.round(H / 4));
    cv.resize(rgb, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const k = Math.max(3, Math.round(Math.min(sw, sh) / 30)) | 1;
    const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
    cv.dilate(small, bg, kern);
    kern.delete();
    cv.GaussianBlur(bg, bg, new cv.Size(k * 2 + 1, k * 2 + 1), 0);
    cv.resize(bg, bgFull, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
    cv.divide(rgb, bgFull, norm, 255);

    // 대비 늘리기 (밝기 기준 1%·99%)
    const d = norm.data as Uint8Array;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 3) hist[(d[i]! * 77 + d[i + 1]! * 150 + d[i + 2]! * 29) >> 8]!++;
    const n = d.length / 3;
    const lo = percentile(hist, n, 0.01);
    const hi = Math.max(lo + 32, percentile(hist, n, 0.99));
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));
    for (let i = 0; i < d.length; i++) d[i] = lut[d[i]!]!;

    let out = norm;
    let bin: CV = null;
    if (opts.binarize) {
      const gray = new cv.Mat();
      bin = new cv.Mat();
      cv.cvtColor(norm, gray, cv.COLOR_RGB2GRAY);
      const block = Math.max(15, Math.round(Math.min(W, H) / 40)) | 1;
      cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
      gray.delete();
      out = bin;
    }
    const raster = matToRaster(cv, out);
    del(bin);
    return { raster, backgroundBefore: before, backgroundAfter: medianGray(raster.data as unknown as Uint8Array, 4) };
  } finally {
    del(rgba, rgb, small, bg, bgFull, norm);
  }
}

function percentile(hist: Uint32Array, n: number, p: number): number {
  const target = n * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= target) return v;
  }
  return 255;
}

/** 밝은 쪽 절반의 중앙값 (종이 배경 밝기 근사) */
function medianGray(d: Uint8Array, stride: number): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i + 2 < d.length; i += stride * 7) {
    hist[(d[i]! * 77 + d[i + 1]! * 150 + d[i + 2]! * 29) >> 8]!++;
    n++;
  }
  // 상위 50% 의 중앙값 = 75 백분위
  return percentile(hist, n, 0.75);
}
