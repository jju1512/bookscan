/**
 * 글자 덩어리 검출 (OpenCV 사용).
 * mzucker/page_dewarp (MIT) 방식을 옮김 — https://github.com/mzucker/page_dewarp
 *
 * 흑백 → adaptiveThreshold(MEAN, INV) → 가로로 dilate → 세로로 erode → 바깥 외곽선 →
 * 너비·높이·가로세로비·두께 필터를 통과한 덩어리만 Blob 으로 만든다.
 */
import { del, type CV, type Raster } from '../raster';
import { assembleSpans, makeBlob, sampleSpans, SPAN_PX_PER_STEP, TEXT_MAX_THICKNESS, TEXT_MIN_ASPECT, TEXT_MIN_HEIGHT, TEXT_MIN_WIDTH, type Blob } from './spans';

/** 작업용 축소의 긴 변 기본값 (page_dewarp 와 같다) */
export const WORK_EDGE = 1280;
/** 작업 해상도 후보 (큰 쪽부터). 글자 크기에 따라 dewarp 가 고른다 */
export const WORK_EDGES = [1280, 960, 720, 540, 400, 300];
/** 여백 (작업 이미지 폭·높이에 대한 비율). 원본의 PAGE_MARGIN_X=50, PAGE_MARGIN_Y=20 (1280×~800 화면 기준)에 해당 */
export const PAGE_MARGIN_X_RATIO = 50 / 1280;
export const PAGE_MARGIN_Y_RATIO = 20 / 800;
export const ADAPTIVE_WINSZ = 55;
export const ADAPTIVE_C = 25;

export interface SmallGray {
  /** 흑백 픽셀 (width*height) */
  data: Uint8Array;
  width: number;
  height: number;
  /** 작업 크기 / 원본 크기 (≤ 1) */
  scale: number;
}

/** 원본 크기 흑백 Mat 을 만든다. 호출한 쪽이 delete() */
function fullGray(cv: CV, src: Raster) {
  const m = new cv.Mat(src.height, src.width, cv.CV_8UC4);
  const gray = new cv.Mat();
  try {
    m.data.set(src.data);
    cv.cvtColor(m, gray, cv.COLOR_RGBA2GRAY);
    return gray;
  } finally {
    del(m);
  }
}

/** 흑백 Mat 을 긴 변 workEdge 이하로 줄인다 (늘리지 않는다) */
function shrinkGray(cv: CV, gray: CV, workEdge: number): SmallGray {
  const long = Math.max(gray.cols, gray.rows);
  if (long <= workEdge) return { data: new Uint8Array(gray.data), width: gray.cols, height: gray.rows, scale: 1 };
  const w = Math.max(2, Math.round((gray.cols * workEdge) / long));
  const h = Math.max(2, Math.round((gray.rows * workEdge) / long));
  const small = new cv.Mat();
  try {
    cv.resize(gray, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    return { data: new Uint8Array(small.data), width: w, height: h, scale: w / gray.cols };
  } finally {
    del(small);
  }
}

/** 원본을 긴 변 workEdge 이하로 줄여 흑백으로 만든다 (늘리지 않는다) */
export function toSmallGray(cv: CV, src: Raster, workEdge = WORK_EDGE): SmallGray {
  const gray = fullGray(cv, src);
  try {
    return shrinkGray(cv, gray, workEdge);
  } finally {
    del(gray);
  }
}

/** 여백 안쪽 사각형 [x0, y0, x1, y1) (작업 이미지 픽셀) */
export function pageRect(width: number, height: number): [number, number, number, number] {
  const mx = Math.round(width * PAGE_MARGIN_X_RATIO);
  const my = Math.round(height * PAGE_MARGIN_Y_RATIO);
  return [mx, my, width - mx, height - my];
}

/** 글자 덩어리 검출. 반환한 Blob 은 OpenCV 자원을 쥐고 있지 않다 */
export function detectBlobs(cv: CV, g: SmallGray): Blob[] {
  const { width: W, height: H } = g;
  const gray = new cv.Mat(H, W, cv.CV_8UC1);
  const mask = new cv.Mat();
  const dil = new cv.Mat();
  const ero = new cv.Mat();
  const kDil = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 1));
  const kEro = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 3));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const blobs: Blob[] = [];
  try {
    gray.data.set(g.data);
    cv.adaptiveThreshold(gray, mask, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, ADAPTIVE_WINSZ, ADAPTIVE_C);
    const anchor = new cv.Point(-1, -1);
    cv.dilate(mask, dil, kDil, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    cv.erode(dil, ero, kEro, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    // 여백 바깥은 지운다
    const [x0, y0, x1, y1] = pageRect(W, H);
    const d = ero.data as Uint8Array;
    for (let y = 0; y < H; y++) {
      const inY = y >= y0 && y < y1;
      for (let x = 0; x < W; x++) if (!inY || x < x0 || x >= x1) d[y * W + x] = 0;
    }
    cv.findContours(ero, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      let tight: CV = null;
      try {
        const r = cv.boundingRect(c);
        if (r.width < TEXT_MIN_WIDTH || r.height < TEXT_MIN_HEIGHT || r.width < TEXT_MIN_ASPECT * r.height) continue;
        tight = cv.Mat.zeros(r.height, r.width, cv.CV_8UC1);
        cv.drawContours(tight, contours, i, new cv.Scalar(1), cv.FILLED, cv.LINE_8, hierarchy, 0, new cv.Point(-r.x, -r.y));
        const t = tight.data as Uint8Array;
        // 열마다 합의 최댓값이 두께
        let thick = 0;
        for (let x = 0; x < r.width; x++) {
          let s = 0;
          for (let y = 0; y < r.height; y++) s += t[y * r.width + x]!;
          if (s > thick) thick = s;
        }
        if (thick > TEXT_MAX_THICKNESS) continue;
        const b = makeBlob(r.x, r.y, r.width, r.height, new Uint8Array(t));
        if (b) blobs.push(b);
      } finally {
        del(c, tight);
      }
    }
    return blobs;
  } finally {
    del(gray, mask, dil, ero, kDil, kEro, contours, hierarchy);
  }
}

/**
 * 글자 크기에 맞는 작업 해상도를 고른다. page_dewarp 의 문턱값(두께 10px, 블록 55px 등)은 글자 줄 간격이 20px 안팎인
 * 해상도를 가정한다. 글자가 큰 페이지는 1280 에서는 덩어리가 너무 두껍게 잡혀 줄이 끊기므로, 후보를 모두 시험해
 * "잡힌 줄의 총 길이(원본 픽셀 환산)"가 가장 큰 해상도를 쓴다. 비슷하게(90% 이상) 잡히면 더 큰 해상도를 쓴다.
 */
export function selectWorkScale(cv: CV, src: Raster, edges: number[]) {
  const long = Math.max(src.width, src.height);
  const tried: Array<{ g: SmallGray; blobs: Blob[]; spans: Blob[][]; cover: number }> = [];
  const done = new Set<number>();
  const full = fullGray(cv, src); // 흑백 변환은 한 번만
  try {
    for (const e0 of edges) {
      const e = Math.min(e0, long); // 늘리지 않는다. 원본보다 큰 후보는 원본 크기로 한 번만
      if (done.has(e)) continue;
      done.add(e);
      const g = shrinkGray(cv, full, e);
      const blobs = detectBlobs(cv, g);
      const spans = assembleSpans(blobs);
      let pts = 0;
      for (const s of sampleSpans(spans, SPAN_PX_PER_STEP)) pts += s.length;
      // 점 하나 = 20px 구간 → 원본 픽셀로 환산한 줄 길이
      tried.push({ g, blobs, spans, cover: (pts * SPAN_PX_PER_STEP) / g.scale });
    }
  } finally {
    del(full);
  }
  const top = Math.max(...tried.map((t) => t.cover));
  const pick = tried.find((t) => t.cover >= top * 0.9) ?? tried[0]!;
  const trials = tried.map((t): [number, number, number] => [Math.max(t.g.width, t.g.height), t.spans.length, Math.round(t.cover)]);
  return { g: pick.g, blobs: pick.blobs, spans: pick.spans, trials };
}
