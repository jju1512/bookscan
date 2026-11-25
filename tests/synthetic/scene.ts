/**
 * 장면 합성: 어두운 책상 위의 펼친 책(또는 한 페이지)을 원근·휘어짐·손가락과 함께 그린다.
 *
 * 좌표계 세 가지
 *  - 페이지 좌표: 페이지 한 장을 그린 평평한 이미지의 픽셀 좌표.
 *  - 책 좌표(book space): 펼침이면 두 페이지를 나란히 붙인 평평한 이미지의 픽셀 좌표 (책등이 x = pageWidth).
 *  - 출력 좌표: 최종 이미지의 픽셀 좌표. 정답(ground truth)은 모두 출력 좌표로 낸다.
 *
 * 책 좌표 (x, y) → 출력 좌표 순서: ① 휘어짐 y' = y + dy(x)  ② 호모그래피(책 사각형 → 출력 임의 사각형).
 * 그림은 출력 픽셀마다 역변환(호모그래피 역 → dy 되돌리기)으로 책 이미지를 양선형 샘플링해서 만든다.
 * 손가락은 종이 위에 있으므로 휘어짐 없이 호모그래피만으로 놓고, 출력 좌표에서 그린다.
 */
import { drawPage } from './page.ts';
import type { PageLine, PageSpec } from './page.ts';
import {
  capsuleSdf,
  compositeOver,
  createImage,
  fillSdf,
  gaussLike,
  mixSeed,
  mulberry32,
  sampleBilinear,
} from './raster.ts';
import type { Pt, RgbaImage, Rgb } from './raster.ts';

/** 사각형 꼭짓점. 왼위·오른위·오른아래·왼아래 순서 */
export type Quad = [Pt, Pt, Pt, Pt];
export type P2 = [number, number];

export type FingerEdge = 'left' | 'right' | 'bottom';

export interface FingerSpec {
  /** 책 바깥 가장자리 중 어느 쪽에서 들어오는가 */
  edge: FingerEdge;
  /** 그 가장자리를 따라 어디서 들어오는가 (left·right 는 위에서 아래로, bottom 은 왼쪽에서 오른쪽으로, 0..1) */
  along: number;
  /** 손가락 끝이 가장자리에서 안쪽으로 들어온 거리. left·right 는 책 폭, bottom 은 책 높이에 대한 비율(둥근 끝 포함) */
  reach: number;
  /** 손가락 반지름(책 좌표 px). 기본 32 */
  radius?: number;
  /** 가장자리에 수직인 방향에서 기울인 각도(도). 기본 0 */
  angleDeg?: number;
}

export type PageOverride = Pick<PageSpec, 'figure' | 'maxLines' | 'lines' | 'paragraphStart' | 'firstBaselineY' | 'sizePx'>;

export interface SceneSpec {
  seed: number;
  mode: 'spread' | 'single';
  outWidth: number;
  outHeight: number;
  /** 책(펼침이면 두 페이지 전체)이 출력에서 차지하는 사각형. 왼위·오른위·오른아래·왼아래 */
  quad: Quad;
  /** 페이지 한 장의 크기(px). 기본 720×1000 */
  pageWidth?: number;
  pageHeight?: number;
  /** 휘어짐 최대 세로 변위 / 페이지 높이 (0이면 평평, 0.03~0.05 가 뚜렷함) */
  curve?: number;
  fingers?: FingerSpec[];
  pages?: { left?: PageOverride; right?: PageOverride; single?: PageOverride };
  /** 출력 픽셀당 샘플 수 = supersample². 기본 2 */
  supersample?: number;
}

export interface FingerTruth {
  edge: FingerEdge;
  /** 출력 좌표의 경계 상자 (이미지 안으로 자른 값) */
  bbox: { x: number; y: number; width: number; height: number };
  /** 손가락 중심선의 바깥쪽(이미지 밖일 수 있음)·끝 점과 반지름(출력 px) */
  base: P2;
  tip: P2;
  radius: number;
  /** 손가락 몸체가 본문 글자 줄 위에 실제로 놓였는가 */
  coversText: boolean;
  coveredLines: number;
}

export interface LineTruth {
  text: string;
  lang: 'ko' | 'en';
  sizePx: number;
  /** 기준선을 따라 균등하게 뽑은 출력 좌표 점들 (휘어짐이 반영된다) */
  baseline: P2[];
}

export interface PageTruth {
  side: 'left' | 'right' | 'single';
  quad: [P2, P2, P2, P2];
  lineCount: number;
  lines: LineTruth[];
}

export interface SceneTruth {
  kind: 'spread' | 'single';
  seed: number;
  width: number;
  height: number;
  /** 책 외곽 꼭짓점: 왼위·오른위·오른아래·왼아래 */
  bookQuad: [P2, P2, P2, P2];
  /** 책등 선의 위·아래 점. 한 페이지면 null */
  spine: { top: P2; bottom: P2 } | null;
  pages: PageTruth[];
  /** 모든 페이지의 글자 줄 수 합 */
  lineCount: number;
  /** 읽는 순서(왼쪽 페이지 → 오른쪽 페이지)로 렌더한 줄 텍스트 */
  lines: string[];
  fingers: FingerTruth[];
  curve: { ratio: number; maxDisplacementPx: number };
}

export interface SceneResult {
  image: RgbaImage;
  truth: SceneTruth;
}

// ───────────────────────── 호모그래피 ─────────────────────────

/** src 사각형 → dst 사각형 호모그래피 (행 우선 3×3, h[8] = 1) */
export function solveHomography(src: Quad, dst: Quad): number[] {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  // 부분 피벗 가우스 소거
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    [a[c], a[piv]] = [a[piv]!, a[c]!];
    const d = a[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new Error('호모그래피를 풀 수 없다 (꼭짓점이 한 직선 위에 있다)');
    for (let k = c; k < 9; k++) a[c]![k]! /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      if (f === 0) continue;
      for (let k = c; k < 9; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  const h = a.map((row) => row[8]!);
  h.push(1);
  return h;
}

export function applyH(h: number[], x: number, y: number): Pt {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w };
}

export function invertH(h: number[]): number[] {
  const [a, b, c, d, e, f, g, i, j] = h as [number, number, number, number, number, number, number, number, number];
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * j - c * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * j - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * i - b * g) / det,
    (a * e - b * d) / det,
  ];
}

// ───────────────────────── 장면 요소 ─────────────────────────

const DESK_BASE = 58;
/** 손가락 기본 피부색. YCrCb 로 Cr≈156, Cb≈103 이라 명세 범위(Cr 140~165, Cb 95~120)의 가운데쯤이다 */
export const SKIN: Rgb = [224, 172, 140];

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
function p2(p: Pt): P2 {
  return [r2(p.x), r2(p.y)];
}

/** 책등 쪽이 어두워지는 세로 띠를 책 이미지에 곱한다. 가장 어두운 선은 x = centerX */
function applySpineShadow(book: RgbaImage, centerX: number, strong: number): void {
  const col = new Float32Array(book.width);
  for (let x = 0; x < book.width; x++) {
    const d = Math.abs(x + 0.5 - centerX);
    col[x] = 1 - strong * 0.62 * Math.exp(-((d / 38) ** 2)) - strong * 0.2 * Math.exp(-((d / 150) ** 2));
  }
  const dat = book.data;
  for (let y = 0; y < book.height; y++) {
    for (let x = 0; x < book.width; x++) {
      const i = (y * book.width + x) * 4;
      const k = col[x]!;
      dat[i] = dat[i]! * k;
      dat[i + 1] = dat[i + 1]! * k;
      dat[i + 2] = dat[i + 2]! * k;
    }
  }
}

interface FingerGeometry {
  edge: FingerEdge;
  base: Pt;
  tip: Pt;
  radius: number;
}

/** 책 좌표의 손가락 사양을 출력 좌표의 중심선·반지름으로 바꾼다 */
function placeFinger(f: FingerSpec, bookW: number, bookH: number, h: number[]): FingerGeometry {
  const r = f.radius ?? 32;
  const a = ((f.angleDeg ?? 0) * Math.PI) / 180;
  // 안쪽으로 향하는 단위 법선
  const n: Pt = f.edge === 'left' ? { x: 1, y: 0 } : f.edge === 'right' ? { x: -1, y: 0 } : { x: 0, y: -1 };
  const dir: Pt = { x: n.x * Math.cos(a) - n.y * Math.sin(a), y: n.x * Math.sin(a) + n.y * Math.cos(a) };
  const dim = f.edge === 'bottom' ? bookH : bookW;
  const depth = Math.max(0, f.reach * dim - r);
  let tip: Pt;
  if (f.edge === 'left') tip = { x: depth, y: f.along * bookH };
  else if (f.edge === 'right') tip = { x: bookW - depth, y: f.along * bookH };
  else tip = { x: f.along * bookW, y: bookH - depth };
  // 책 밖으로 충분히 멀리 뻗은 지점을 손가락의 뿌리로 쓴다 (화면 밖에서 시작하게)
  const len = (depth + Math.max(6 * r, 260)) / Math.max(0.5, Math.cos(a));
  const base: Pt = { x: tip.x - dir.x * len, y: tip.y - dir.y * len };
  const t = applyH(h, tip.x, tip.y);
  const tx = applyH(h, tip.x + r, tip.y);
  const ty = applyH(h, tip.x, tip.y + r);
  const radius = (Math.hypot(tx.x - t.x, tx.y - t.y) + Math.hypot(ty.x - t.x, ty.y - t.y)) / 2;
  return { edge: f.edge, base: applyH(h, base.x, base.y), tip: t, radius };
}

/** 손가락(둥근 막대)을 출력 이미지에 그린다: 종이 위 그림자 → 피부색 몸체(음영과 약한 질감) */
function paintFinger(img: RgbaImage, g: FingerGeometry, rng: () => number): void {
  const { base, tip, radius: r } = g;
  const x0 = Math.min(base.x, tip.x) - r - 30;
  const y0 = Math.min(base.y, tip.y) - r - 30;
  const x1 = Math.max(base.x, tip.x) + r + 30;
  const y1 = Math.max(base.y, tip.y) + r + 30;
  // 그림자: 몸체를 (+4,+6) 옮긴 거리장에서 부드럽게 줄어드는 어둠
  const sx0 = Math.max(0, Math.floor(x0));
  const sy0 = Math.max(0, Math.floor(y0));
  const sx1 = Math.min(img.width, Math.ceil(x1));
  const sy1 = Math.min(img.height, Math.ceil(y1));
  for (let y = sy0; y < sy1; y++) {
    for (let x = sx0; x < sx1; x++) {
      const d = capsuleSdf(x + 0.5 - 4, y + 0.5 - 6, base.x, base.y, tip.x, tip.y, r);
      if (d > 20) continue;
      const a = 0.38 * Math.exp(-Math.max(d, 0) / 7);
      const i = (y * img.width + x) * 4;
      const k = 1 - a;
      img.data[i] = img.data[i]! * k;
      img.data[i + 1] = img.data[i + 1]! * k;
      img.data[i + 2] = img.data[i + 2]! * k;
    }
  }
  // 몸체
  const vx = tip.x - base.x;
  const vy = tip.y - base.y;
  const vl = Math.hypot(vx, vy) || 1;
  const ux = vx / vl;
  const uy = vy / vl;
  fillSdf(
    img,
    { x0, y0, x1, y1 },
    (px, py) => capsuleSdf(px, py, base.x, base.y, tip.x, tip.y, r),
    (px, py, d) => {
      // 중심선에서 옆으로 얼마나 떨어졌는가 (-1..1): 가운데가 밝고 가장자리가 어둡다
      const c = Math.max(-1, Math.min(1, ((px - base.x) * -uy + (py - base.y) * ux) / r));
      let shade = 1.04 - 0.22 * c * c + 0.05 * c;
      if (d > -1.5) shade *= 0.93;
      shade += (rng() - 0.5) * 0.025;
      return [Math.min(255, SKIN[0] * shade), Math.min(255, SKIN[1] * shade), Math.min(255, SKIN[2] * shade)];
    },
  );
}

// ───────────────────────── 장면 그리기 ─────────────────────────

export function renderScene(spec: SceneSpec): SceneResult {
  const pw = spec.pageWidth ?? 720;
  const ph = spec.pageHeight ?? 1000;
  const spread = spec.mode === 'spread';
  const bookW = spread ? pw * 2 : pw;
  const bookH = ph;
  const ow = spec.outWidth;
  const oh = spec.outHeight;

  // 1) 평평한 책 이미지
  const pageRenders: Array<{ side: 'left' | 'right' | 'single'; offsetX: number; render: ReturnType<typeof drawPage> }> = [];
  const sides: Array<'left' | 'right' | 'single'> = spread ? ['left', 'right'] : ['single'];
  const book = createImage(bookW, bookH, [0, 0, 0]);
  sides.forEach((side, idx) => {
    const ov = spec.pages?.[side] ?? {};
    const offsetX = side === 'right' ? pw : 0;
    const render = drawPage({
      width: pw,
      height: ph,
      side,
      seed: mixSeed(spec.seed, idx + 1),
      paragraphStart: ov.paragraphStart ?? (side === 'right' ? 5 : side === 'single' ? 2 : 0),
      ...ov,
    });
    compositeOver(book, render.image, offsetX, 0);
    pageRenders.push({ side, offsetX, render });
  });
  if (spread) applySpineShadow(book, pw, 1);
  else applySpineShadow(book, 0, 0.45);

  // 2) 변환
  const quad = spec.quad;
  const H = solveHomography([{ x: 0, y: 0 }, { x: bookW, y: 0 }, { x: bookW, y: bookH }, { x: 0, y: bookH }], quad);
  const Hinv = invertH(H);
  const curve = spec.curve ?? 0;
  const maxDy = curve * bookH;
  const bell = (t: number): number => Math.exp(-((t / 0.5) ** 2));
  /** 책 좌표 x 에서 세로 변위 (책등에 가까울수록 크다) */
  const dyAt = (x: number): number => (maxDy === 0 ? 0 : maxDy * bell(spread ? Math.abs(x - bookW / 2) / (bookW / 2) : x / bookW));
  const forward = (x: number, y: number): Pt => applyH(H, x, y + dyAt(x));

  // 3) 역사상으로 출력 그리기
  const out = createImage(ow, oh, [0, 0, 0]);
  const rng = mulberry32(mixSeed(spec.seed, 0x6465736b));
  const ss = spec.supersample ?? 2;
  const nSamples = ss * ss;
  const tmp = new Float64Array(4);
  const phase = rng() * 6;
  for (let Y = 0; Y < oh; Y++) {
    for (let X = 0; X < ow; X++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let desk = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const sx = X + (i + 0.5) / ss;
          const sy = Y + (j + 0.5) / ss;
          const w = Hinv[6]! * sx + Hinv[7]! * sy + Hinv[8]!;
          const bx = (Hinv[0]! * sx + Hinv[1]! * sy + Hinv[2]!) / w;
          const by = (Hinv[3]! * sx + Hinv[4]! * sy + Hinv[5]!) / w - dyAt(bx);
          if (bx >= 0 && bx < bookW && by >= 0 && by < bookH) {
            sampleBilinear(book, bx, by, tmp);
            r += tmp[0]!;
            g += tmp[1]!;
            b += tmp[2]!;
          } else {
            // 책상: 완만하게 변하는 밝기, 책 가장자리 가까이에 드리운 그림자
            const dist = Math.hypot(Math.max(-bx, 0, bx - bookW), Math.max(-by, 0, by - bookH));
            const tone = DESK_BASE + 6 * Math.sin(sx / 190 + phase) * Math.cos(sy / 260 - phase) + 3 * Math.sin((sx + sy) / 90);
            const v = tone * (1 - 0.5 * Math.exp(-dist / 28));
            r += v;
            g += v;
            b += v * 0.97;
            desk++;
          }
        }
      }
      const o = (Y * ow + X) * 4;
      out.data[o] = r / nSamples;
      out.data[o + 1] = g / nSamples;
      out.data[o + 2] = b / nSamples;
      out.data[o + 3] = 255;
      if (desk > 0) {
        const n = Math.round(gaussLike(rng) * 0.5 * (desk / nSamples));
        out.data[o] = out.data[o]! + n;
        out.data[o + 1] = out.data[o + 1]! + n;
        out.data[o + 2] = out.data[o + 2]! + n;
      }
    }
  }

  // 4) 손가락 (출력 좌표에서 그린다)
  const fingerGeoms = (spec.fingers ?? []).map((f) => placeFinger(f, bookW, bookH, H));
  const frng = mulberry32(mixSeed(spec.seed, 0x66696e67));
  for (const g of fingerGeoms) paintFinger(out, g, frng);

  // 5) 정답
  const pagesTruth: PageTruth[] = [];
  const allLines: string[] = [];
  const coverage = fingerGeoms.map(() => new Set<string>());
  for (const pr of pageRenders) {
    const lines: LineTruth[] = pr.render.lines.map((ln: PageLine) => {
      const pts: P2[] = [];
      for (let k = 0; k <= 8; k++) {
        const x = pr.offsetX + ln.x0 + ((ln.x1 - ln.x0) * k) / 8;
        pts.push(p2(forward(x, ln.baselineY)));
      }
      // 손가락 몸체가 글자 줄(기준선 위 글자 높이의 한가운데 높이)을 지나는지 샘플링으로 확인
      const lineKey = `${pr.side}:${ln.baselineY}`;
      for (let k = 0; k <= 40; k++) {
        const x = pr.offsetX + ln.x0 + ((ln.x1 - ln.x0) * k) / 40;
        const q = forward(x, ln.baselineY - ln.sizePx * 0.3);
        fingerGeoms.forEach((g, fi) => {
          if (capsuleSdf(q.x, q.y, g.base.x, g.base.y, g.tip.x, g.tip.y, g.radius) < 0) coverage[fi]!.add(lineKey);
        });
      }
      return { text: ln.text, lang: ln.lang, sizePx: ln.sizePx, baseline: pts };
    });
    for (const l of lines) allLines.push(l.text);
    const x0 = pr.offsetX;
    const x1 = pr.offsetX + pw;
    pagesTruth.push({
      side: pr.side,
      quad: [p2(forward(x0, 0)), p2(forward(x1, 0)), p2(forward(x1, bookH)), p2(forward(x0, bookH))],
      lineCount: lines.length,
      lines,
    });
  }

  const fingers: FingerTruth[] = fingerGeoms.map((g, fi) => {
    const r = g.radius;
    const bx0 = Math.max(0, Math.min(g.base.x, g.tip.x) - r);
    const by0 = Math.max(0, Math.min(g.base.y, g.tip.y) - r);
    const bx1 = Math.min(ow, Math.max(g.base.x, g.tip.x) + r);
    const by1 = Math.min(oh, Math.max(g.base.y, g.tip.y) + r);
    const n = coverage[fi]!.size;
    return {
      edge: g.edge,
      bbox: { x: r2(bx0), y: r2(by0), width: r2(bx1 - bx0), height: r2(by1 - by0) },
      base: p2(g.base),
      tip: p2(g.tip),
      radius: r2(r),
      coversText: n > 0,
      coveredLines: n,
    };
  });

  const truth: SceneTruth = {
    kind: spec.mode,
    seed: spec.seed,
    width: ow,
    height: oh,
    bookQuad: [p2(forward(0, 0)), p2(forward(bookW, 0)), p2(forward(bookW, bookH)), p2(forward(0, bookH))],
    spine: spread ? { top: p2(forward(pw, 0)), bottom: p2(forward(pw, bookH)) } : null,
    pages: pagesTruth,
    lineCount: pagesTruth.reduce((s, p) => s + p.lineCount, 0),
    lines: allLines,
    fingers,
    curve: { ratio: curve, maxDisplacementPx: r2(maxDy) },
  };
  return { image: out, truth };
}
