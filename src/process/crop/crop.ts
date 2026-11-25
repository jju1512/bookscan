/**
 * 자르기·분할 (SPEC 8장).
 * 1. 가장자리 검출(Canny) → 책 외곽의 가장 큰 사각형 → 원근 보정.
 *    Canny 로 못 찾으면 밝은 종이 영역(Otsu)으로 한 번 더 찾는다.
 * 2. 펼침이면 가운데 영역(40~60%)에서 세로로 가장 어두운 선(책등 그림자)을 찾아 좌우로 나눈다.
 * 실패하면: 원본을 그대로 쓰고(펼침이면 가운데 어두운 선으로만 나눔) 수동 보정 UI 를 띄우도록 failed 로 알린다.
 * 수동 보정값(꼭짓점·분할선)이 있으면 검출 없이 그 값을 쓴다.
 */
import { cornersToNorm, extremeCorners, isConvex, normToCorners, orderCorners, polygonArea, smooth, warpSize, type Pt } from '../geom';
import { del, matToRaster, rasterToMat, type CV, type Raster } from '../raster';

export interface CropInput {
  side: 'left' | 'right' | 'single';
  manual?: { corners?: number[]; splitX?: number };
}

export interface CropResult {
  raster: Raster;
  /** 검출했거나 수동으로 준 꼭짓점 (원본 비율 좌표) */
  corners: number[];
  /** 분할선 (원근 보정한 이미지 폭에 대한 비율). 한 페이지면 undefined */
  splitX?: number;
  /** 책 외곽을 찾았는가 (수동 값이면 true) */
  found: boolean;
  method: 'manual' | 'canny' | 'otsu' | 'none';
  note?: string;
}

/** 검출에 쓰는 축소 크기 (긴 변) */
export const DETECT_EDGE = 800;
/** 이보다 작은 사각형은 책으로 보지 않는다 (이미지 면적 비율) */
export const MIN_AREA_RATIO = 0.2;
/** 책등을 찾는 가로 범위 */
export const SPINE_RANGE: [number, number] = [0.4, 0.6];

export function cropPage(cv: CV, src: Raster, input: CropInput): CropResult {
  const W = src.width;
  const H = src.height;
  let corners: [Pt, Pt, Pt, Pt] | null = null;
  let method: CropResult['method'] = 'none';
  if (input.manual?.corners?.length === 8) {
    corners = normToCorners(input.manual.corners, W, H);
    method = 'manual';
  } else {
    const d = detectPageQuad(cv, src);
    if (d) {
      corners = d.corners;
      method = d.method;
    }
  }
  const found = corners !== null;
  const quad = corners ?? ([[0, 0], [W, 0], [W, H], [0, H]] as [Pt, Pt, Pt, Pt]);
  const warped = found ? warpQuad(cv, src, quad) : src;

  let splitX: number | undefined;
  let out = warped;
  if (input.side !== 'single') {
    splitX = input.manual?.splitX ?? findSpine(warped);
    const sx = Math.round(splitX * warped.width);
    out = input.side === 'left' ? subRaster(warped, 0, sx) : subRaster(warped, sx, warped.width);
  }
  return {
    raster: out,
    corners: cornersToNorm(quad, W, H),
    splitX,
    found,
    method,
    note: found ? undefined : '책 외곽을 찾지 못해 원본을 그대로 썼습니다. 수동 보정으로 꼭짓점을 맞춰 주세요.',
  };
}

/** 책 외곽 사각형을 원본 픽셀 좌표로 찾는다. 못 찾으면 null */
export function detectPageQuad(cv: CV, src: Raster): { corners: [Pt, Pt, Pt, Pt]; method: 'canny' | 'otsu'; areaRatio: number } | null {
  const scale = Math.min(1, DETECT_EDGE / Math.max(src.width, src.height));
  const rgba = rasterToMat(cv, src);
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const bin = new cv.Mat();
  try {
    cv.resize(rgba, small, new cv.Size(Math.round(src.width * scale), Math.round(src.height * scale)), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const area = small.rows * small.cols;

    // 1차: Canny 가장자리 → 굵게 이어 붙여 닫힌 외곽선
    cv.Canny(blur, bin, 40, 120);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(bin, bin, k);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
    k.delete();
    let quad = largestQuad(cv, bin, area, true);
    let method: 'canny' | 'otsu' = 'canny';
    if (!quad) {
      // 2차: 밝은 종이 영역
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k2);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k2);
      k2.delete();
      quad = largestQuad(cv, bin, area, false);
      method = 'otsu';
    }
    if (!quad) return null;
    const inv = 1 / scale;
    const corners = quad.pts.map(([x, y]) => [x * inv, y * inv] as Pt);
    return { corners: orderCorners(corners), method, areaRatio: quad.ratio };
  } finally {
    del(rgba, small, gray, blur, bin);
  }
}

function largestQuad(cv: CV, bin: CV, imageArea: number, edgeMode: boolean): { pts: Pt[]; ratio: number } | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best: { pts: Pt[]; ratio: number } | null = null;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const hullArea = cv.contourArea(hull);
      const ratio = hullArea / imageArea;
      // 이미지 전체를 덮는 외곽선(가장자리 띠)은 책이 아니다
      if (ratio < MIN_AREA_RATIO || ratio > (edgeMode ? 0.985 : 0.995) || (best && ratio <= best.ratio)) {
        c.delete();
        hull.delete();
        continue;
      }
      const pts = quadFromHull(cv, hull);
      c.delete();
      hull.delete();
      if (pts && isConvex(orderCorners(pts)) && polygonArea(orderCorners(pts)) / imageArea >= MIN_AREA_RATIO) best = { pts, ratio };
    }
    return best;
  } finally {
    del(contours, hierarchy);
  }
}

/** 볼록 껍질을 4점으로 줄인다. approxPolyDP 의 허용 오차를 늘려 가며 시도하고, 안 되면 네 극점 */
function quadFromHull(cv: CV, hull: CV): Pt[] | null {
  const peri = cv.arcLength(hull, true);
  for (const eps of [0.02, 0.03, 0.04, 0.06, 0.08]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, eps * peri, true);
    if (approx.rows === 4) {
      const pts: Pt[] = [];
      for (let j = 0; j < 4; j++) pts.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]]);
      approx.delete();
      return pts;
    }
    approx.delete();
  }
  const pts: Pt[] = [];
  for (let j = 0; j < hull.rows; j++) pts.push([hull.data32S[j * 2], hull.data32S[j * 2 + 1]]);
  return pts.length >= 4 ? extremeCorners(pts) : null;
}

export function warpQuad(cv: CV, src: Raster, quad: [Pt, Pt, Pt, Pt]): Raster {
  const { width, height } = warpSize(quad);
  const m = rasterToMat(cv, src);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const M = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(m, dst, M, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    return matToRaster(cv, dst);
  } finally {
    del(m, dst, from, to, M);
  }
}

/**
 * 책등(가운데 세로 그림자) 위치를 이미지 폭에 대한 비율로. 위아래 10%는 빼고 세로 평균 밝기가 가장 낮은 열.
 * OpenCV 없이 계산한다.
 */
export function findSpine(r: Raster, range: [number, number] = SPINE_RANGE): number {
  const { width: w, height: h, data } = r;
  const x0 = Math.max(0, Math.floor(w * range[0]));
  const x1 = Math.min(w, Math.ceil(w * range[1]));
  const y0 = Math.floor(h * 0.1);
  const y1 = Math.ceil(h * 0.9);
  const ystep = Math.max(1, Math.floor((y1 - y0) / 400));
  const col = new Float64Array(x1 - x0);
  for (let x = x0; x < x1; x++) {
    let s = 0;
    let n = 0;
    for (let y = y0; y < y1; y += ystep) {
      const i = (y * w + x) * 4;
      s += data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114;
      n++;
    }
    col[x - x0] = s / n;
  }
  const sm = smooth(col, Math.max(1, Math.round(w * 0.006)));
  let best = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i]! < sm[best]!) best = i;
  return (x0 + best) / w;
}

export function subRaster(r: Raster, x0: number, x1: number): Raster {
  const a = Math.max(0, Math.min(r.width, x0));
  const b = Math.max(a + 1, Math.min(r.width, x1));
  const w = b - a;
  const out = new Uint8ClampedArray(w * r.height * 4);
  for (let y = 0; y < r.height; y++) out.set(r.data.subarray((y * r.width + a) * 4, (y * r.width + b) * 4), y * w * 4);
  return { width: w, height: r.height, data: out };
}
