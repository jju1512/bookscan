/**
 * 손가락 지우기 (SPEC 8장).
 * 1. YCrCb 피부색 범위로 마스크를 만들고 열기·닫기로 다듬는다.
 * 2. 페이지 가장자리 띠에 닿아 있는 덩어리만 손가락으로 본다 (손가락은 바깥에서 들어온다).
 * 3. 덩어리마다:
 *    - 둘레에 본문 글자가 이어지면 → 글자를 덮은 것. 지우지 않고 표시만 한다 (가려진 글자는 복원할 수 없다).
 *    - 본문 글자 영역(글자 상자) 밖, 여백에만 있으면 → 종이 배경색으로 채운다.
 *    - 그 밖(글자 상자 안이지만 글자와 겹치지 않음) → cv.inpaint(Telea) 로 메운다.
 */
import { del, matToRaster, rasterToMat, type CV, type Raster } from '../raster';

export interface FingerOptions {
  /** 가장자리 띠 두께 (짧은 변 대비) */
  band?: number;
  /** 피부색 범위 */
  cr?: [number, number];
  cb?: [number, number];
}

export interface FingerRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  action: 'filled' | 'inpainted' | 'overText';
}

export interface FingerResult {
  raster: Raster;
  /** 바꾼 것이 있는가 (없으면 앞 단계 결과를 그대로 쓴다) */
  changed: boolean;
  regions: FingerRegion[];
  overText: boolean;
}

export const SKIN_CR: [number, number] = [135, 180];
export const SKIN_CB: [number, number] = [85, 135];

export function removeFingers(cv: CV, src: Raster, opts: FingerOptions = {}): FingerResult {
  const W = src.width;
  const H = src.height;
  const band = Math.round(Math.min(W, H) * (opts.band ?? 0.12));
  const cr = opts.cr ?? SKIN_CR;
  const cb = opts.cb ?? SKIN_CB;
  const rgba = rasterToMat(cv, src);
  const rgb = new cv.Mat();
  const ycc = new cv.Mat();
  const skin = new cv.Mat();
  const gray = new cv.Mat();
  const text = new cv.Mat();
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const cents = new cv.Mat();
  const low = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(40, cr[0], cb[0]));
  const high = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(255, cr[1], cb[1]));
  const regions: FingerRegion[] = [];
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, ycc, cv.COLOR_RGB2YCrCb);
    cv.inRange(ycc, low, high, skin);
    const k5 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    const k9 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
    cv.morphologyEx(skin, skin, cv.MORPH_OPEN, k5);
    cv.morphologyEx(skin, skin, cv.MORPH_CLOSE, k9);
    k5.delete();
    k9.delete();

    // 본문 글자 마스크: 어두운 작은 무늬 (적응형 임계값). 피부 영역은 뺀다
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const block = oddAtLeast(Math.round(Math.min(W, H) / 40), 15);
    cv.adaptiveThreshold(gray, text, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, 15);
    const skinDil = new cv.Mat();
    const kd = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(15, 15));
    cv.dilate(skin, skinDil, kd);
    kd.delete();
    const notSkin = new cv.Mat();
    cv.bitwise_not(skinDil, notSkin);
    cv.bitwise_and(text, notSkin, text);
    notSkin.delete();
    const textBox = textBounds(text, W, H);
    const textDensity = textBox ? cv.countNonZero(text) / (textBox.w * textBox.h) : 0;

    const n = cv.connectedComponentsWithStats(skin, labels, stats, cents, 8, cv.CV_32S);
    const minArea = W * H * 0.0008;
    const fillMask = cv.Mat.zeros(H, W, cv.CV_8UC1);
    const inpaintMask = cv.Mat.zeros(H, W, cv.CV_8UC1);
    const lab = labels.data32S as Int32Array;
    let changed = false;
    let overText = false;
    for (let i = 1; i < n; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT);
      const y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH);
      const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      const area = stats.intAt(i, cv.CC_STAT_AREA);
      if (area < minArea) continue;
      const touchesBand = x <= band * 0.25 || y <= band * 0.25 || x + w >= W - band * 0.25 || y + h >= H - band * 0.25;
      if (!touchesBand) continue;
      // 덩어리 둘레 고리에 글자 픽셀이 얼마나 있나
      // 고리 반지름은 피부 마스크를 키운 폭(7px)보다 넉넉히: 그 안쪽은 글자 마스크에서 빠져 있다
      const ring = ringTextDensity(lab, i, text.data as Uint8Array, W, H, x, y, w, h, Math.max(12, Math.round(Math.min(W, H) * 0.03)));
      const insideText = textBox !== null && overlap(textBox, { x, y, w, h }) > 0.15 * w * h;
      let action: FingerRegion['action'];
      // 둘레의 글자 밀도가 본문 평균 밀도의 25% 이상이면 글자 줄이 손가락 밑으로 이어진다고 본다
      if (insideText && ring > 0.25 * textDensity) {
        action = 'overText';
        overText = true;
      } else {
        action = insideText ? 'inpainted' : 'filled';
        const target = action === 'filled' ? fillMask : inpaintMask;
        const td = target.data as Uint8Array;
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (lab[yy * W + xx] === i) td[yy * W + xx] = 255;
        changed = true;
      }
      regions.push({ x, y, w, h, area, action });
    }

    let out = rgb;
    if (changed) {
      const kgrow = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
      cv.dilate(fillMask, fillMask, kgrow);
      cv.dilate(inpaintMask, inpaintMask, kgrow);
      kgrow.delete();
      // 여백: 종이 배경색 (덩어리 둘레의 밝은 픽셀 중앙값)으로 채운다
      if (cv.countNonZero(fillMask) > 0) {
        const color = paperColor(rgb.data as Uint8Array, fillMask.data as Uint8Array, gray.data as Uint8Array, W, H);
        rgb.setTo(new cv.Scalar(color[0], color[1], color[2]), fillMask);
      }
      if (cv.countNonZero(inpaintMask) > 0) {
        const dst = new cv.Mat();
        cv.inpaint(rgb, inpaintMask, dst, 5, cv.INPAINT_TELEA);
        out = dst;
      }
    }
    const raster = matToRaster(cv, out);
    if (out !== rgb) out.delete();
    del(fillMask, inpaintMask, skinDil);
    return { raster, changed, regions, overText };
  } finally {
    del(rgba, rgb, ycc, skin, gray, text, labels, stats, cents, low, high);
  }
}

function oddAtLeast(v: number, min: number): number {
  const x = Math.max(min, v);
  return x % 2 ? x : x + 1;
}

interface Box { x: number; y: number; w: number; h: number }

/** 글자 픽셀이 모인 상자 (행·열 투영에서 밀도가 있는 범위). 글자가 거의 없으면 null */
function textBounds(text: { data: Uint8Array }, W: number, H: number): Box | null {
  const rows = new Float64Array(H);
  const cols = new Float64Array(W);
  const d = text.data;
  let total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[y * W + x]) {
        rows[y]!++;
        cols[x]!++;
        total++;
      }
    }
  }
  if (total < W * H * 0.002) return null;
  const range = (arr: Float64Array, len: number, other: number) => {
    const th = other * 0.01;
    let a = 0;
    while (a < len && arr[a]! <= th) a++;
    let b = len - 1;
    while (b > a && arr[b]! <= th) b--;
    return [a, b] as const;
  };
  const [y0, y1] = range(rows, H, W);
  const [x0, x1] = range(cols, W, H);
  if (y1 <= y0 || x1 <= x0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 덩어리를 r 만큼 키운 고리에서 글자 픽셀 비율 */
function ringTextDensity(lab: Int32Array, id: number, text: Uint8Array, W: number, H: number, x: number, y: number, w: number, h: number, r: number): number {
  let ring = 0;
  let hit = 0;
  const x0 = Math.max(0, x - r);
  const x1 = Math.min(W - 1, x + w + r);
  const y0 = Math.max(0, y - r);
  const y1 = Math.min(H - 1, y + h + r);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000)));
  for (let yy = y0; yy <= y1; yy += step) {
    for (let xx = x0; xx <= x1; xx += step) {
      if (lab[yy * W + xx] === id) continue;
      // 덩어리에서 r 안쪽인지 (근사: 가까운 4방향에 덩어리 픽셀이 있는가)
      let near = false;
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const nx = xx + dx;
        const ny = yy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && lab[ny * W + nx] === id) {
          near = true;
          break;
        }
      }
      if (!near) continue;
      ring++;
      if (text[yy * W + xx]) hit++;
    }
  }
  return ring ? hit / ring : 0;
}

/** 마스크 둘레의 밝은(종이) 픽셀 색 중앙값 */
function paperColor(rgb: Uint8Array, mask: Uint8Array, gray: Uint8Array, W: number, H: number): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 200000)));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = y * W + x;
      if (mask[i]) continue;
      // 마스크 근처(16px 안)만
      let near = false;
      for (const d of [16, -16]) {
        if ((x + d >= 0 && x + d < W && mask[i + d]) || (y + d >= 0 && y + d < H && mask[i + d * W])) near = true;
      }
      if (!near || gray[i]! < 150) continue;
      rs.push(rgb[i * 3]!);
      gs.push(rgb[i * 3 + 1]!);
      bs.push(rgb[i * 3 + 2]!);
    }
  }
  if (rs.length === 0) return [245, 242, 235];
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]!;
  return [med(rs), med(gs), med(bs)];
}
