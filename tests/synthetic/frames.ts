/**
 * 자동 촬영 재생 테스트용 프레임 시퀀스 생성기 (저해상도 RGBA).
 *
 * 장면: 어두운 책상 위의 펼친 책. 페이지(= 펼침 한 장면)마다 글자 줄 무늬가 확실히 다르다.
 * 페이지 넘김: 손(피부색 덩어리)이 오른쪽 아래에서 들어와 오른쪽 종이를 잡고, 종이가 책등을 축으로 왼쪽으로 넘어가고
 * (중간 프레임은 폭이 줄었다 늘어나는 휘어진 종이 + 그림자), 손이 왼쪽 아래로 나가며, 새 페이지로 멈춘다.
 *
 * 용어: `pages` 는 보여 줄 펼침 장면의 수다. 첫 장면은 처음부터 보이고, 넘김은 pages - 1 번 있다.
 * 이벤트의 `afterPage` 는 1부터 센 페이지 번호다.
 *
 * 프레임은 시각 t(ms) 순서로 나온다. 모든 난수는 (seed, 프레임 번호)로 정해져서 같은 입력은 같은 바이트를 낸다.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import {
  addNoise,
  compositeOver,
  createImage,
  fillCapsule,
  fillEllipse,
  fillRect,
  mixSeed,
  mulberry32,
  sampleBilinear,
} from './raster.ts';
import type { Rgb, RgbaImage } from './raster.ts';

export interface SynthFrame {
  /** 시작부터의 시각(ms) */
  t: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface TurnScript {
  fps?: number;
  width?: number;
  height?: number;
  /** 보여 줄 펼침 장면(페이지)의 수. 첫 장면 포함, 넘김은 pages - 1 번 */
  pages: number;
  /** 각 페이지가 멈춰 있는 시간(ms). 기본 1500 */
  stillMs?: number;
  /** 페이지 한 번 넘기는 데 걸리는 시간(ms). 손이 들어오는 것부터 나가는 것까지. 기본 700 */
  turnMs?: number;
  seed?: number;
  events?: Array<{ kind: 'handOnly' | 'shake' | 'blur' | 'slowTurn'; afterPage: number }>;
}

/**
 * 이벤트 의미 (afterPage = k, 1부터 센 페이지 번호)
 *  - handOnly: 페이지 k 가 멈춘 뒤(stillMs 가 지난 뒤) 손만 들어왔다 나간다. 페이지는 그대로 → 촬영되면 안 된다.
 *  - shake:    페이지 k 가 멈춘 뒤 약 0.5초 동안 프레임 전체가 1~3px(폭 160 기준) 흔들린다. 같은 페이지 → 촬영되면 안 된다.
 *  - blur:     k → k+1 넘김 직후 새 페이지의 처음 0.3초가 흐리다가 선명해진다. 최종 촬영은 1번이어야 한다. (k < pages)
 *  - slowTurn: k → k+1 넘김이 아주 느리다(turnMs 의 20배, 최소 14초. 넘어가는 종이 안의 무늬도 같이 찌그러지므로 이 정도는 돼야 프레임당 변화가 5% 아래다). 프레임당 움직임이 작아 MOVE 를 못 넘길 수 있다. (k < pages)
 */
export type TurnEventKind = NonNullable<TurnScript['events']>[number]['kind'];

export interface TurnPlan {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  /**
   * 기대 촬영 횟수 = 첫 페이지 1장 + 실제로 넘긴 횟수 = pages.
   * handOnly·shake·blur 는 넘김이 아니므로 더하지 않는다.
   * slowTurn 은 종이가 실제로 넘어갔으므로 넘긴 횟수에 센다. 다만 감지기가 놓칠 수 있다(움직임이 MOVE 아래로 작음).
   * 그래서 slowTurn 이 있는 시나리오의 허용 하한은 expectedCaptures - slowTurnCount 이고, 상한은 expectedCaptures 다.
   */
  expectedCaptures: number;
  slowTurnCount: number;
  /** 페이지 i(0부터)가 멈추기 시작한 시각(ms). 촬영이 일어날 수 있는 가장 이른 시각의 기준 */
  pageStillStartMs: number[];
  /** 총 길이(ms) */
  durationMs: number;
}

type Segment =
  | { kind: 'still'; page: number; frames: number; blurFrames: number }
  | { kind: 'turn'; from: number; frames: number }
  | { kind: 'hand'; page: number; frames: number }
  | { kind: 'shake'; page: number; frames: number };

const BLUR_MS = 300;
const SETTLE_MS = 500;
const SHAKE_MS = 500;

function msToFrames(ms: number, fps: number): number {
  return Math.max(1, Math.round((ms * fps) / 1000));
}

interface Resolved {
  fps: number;
  width: number;
  height: number;
  pages: number;
  seed: number;
  segments: Segment[];
  plan: TurnPlan;
}

function resolveScript(script: TurnScript): Resolved {
  const fps = script.fps ?? 15;
  const width = script.width ?? 160;
  const height = script.height ?? 120;
  const pages = script.pages;
  const stillMs = script.stillMs ?? 1500;
  const turnMs = script.turnMs ?? 700;
  const seed = script.seed ?? 1;
  const events = script.events ?? [];
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError(`pages 는 1 이상의 정수여야 한다: ${pages}`);
  if (!(fps > 0)) throw new RangeError(`fps 가 올바르지 않다: ${fps}`);
  for (const e of events) {
    if (!Number.isInteger(e.afterPage) || e.afterPage < 1 || e.afterPage > pages) {
      throw new RangeError(`afterPage 는 1..${pages} 여야 한다: ${e.kind}/${e.afterPage}`);
    }
    if ((e.kind === 'blur' || e.kind === 'slowTurn') && e.afterPage >= pages) {
      throw new RangeError(`${e.kind} 는 다음 페이지로 넘기는 동작이라 afterPage < pages 여야 한다: ${e.afterPage}`);
    }
  }

  const segments: Segment[] = [];
  const pageStillStartMs: number[] = [];
  let frameCount = 0;
  const push = (s: Segment): void => {
    segments.push(s);
    frameCount += s.frames;
  };
  let slowTurnCount = 0;
  for (let p = 0; p < pages; p++) {
    pageStillStartMs.push((frameCount * 1000) / fps);
    const blurFrames = events.some((e) => e.kind === 'blur' && e.afterPage === p) ? Math.max(1, Math.round((BLUR_MS * fps) / 1000)) : 0;
    push({ kind: 'still', page: p, frames: msToFrames(stillMs, fps), blurFrames });
    for (const e of events) {
      if (e.afterPage !== p + 1) continue;
      if (e.kind === 'handOnly') {
        push({ kind: 'hand', page: p, frames: msToFrames(turnMs, fps) });
        push({ kind: 'still', page: p, frames: msToFrames(SETTLE_MS, fps), blurFrames: 0 });
      } else if (e.kind === 'shake') {
        push({ kind: 'shake', page: p, frames: Math.max(4, msToFrames(SHAKE_MS, fps)) });
        push({ kind: 'still', page: p, frames: msToFrames(SETTLE_MS, fps), blurFrames: 0 });
      }
    }
    if (p < pages - 1) {
      const slow = events.some((e) => e.kind === 'slowTurn' && e.afterPage === p + 1);
      if (slow) slowTurnCount++;
      push({ kind: 'turn', from: p, frames: msToFrames(slow ? Math.max(turnMs * 20, 14000) : turnMs, fps) });
    }
  }
  const plan: TurnPlan = {
    fps,
    width,
    height,
    totalFrames: frameCount,
    expectedCaptures: pages,
    slowTurnCount,
    pageStillStartMs,
    durationMs: (frameCount * 1000) / fps,
  };
  return { fps, width, height, pages, seed, segments, plan };
}

/** 렌더 없이 계획(프레임 수·기대 촬영 횟수)만 계산한다 */
export function planTurns(script: TurnScript): TurnPlan {
  return resolveScript(script).plan;
}

// ───────────────────────── 장면 그리기 ─────────────────────────

const DESK: Rgb = [58, 58, 58];
const PAPER_TONE: Rgb = [236, 233, 224];
const INK_TONE: Rgb = [60, 60, 64];
const SKIN_TONE: Rgb = [222, 170, 138];

interface Layout {
  W: number;
  H: number;
  bx0: number;
  bx1: number;
  by0: number;
  by1: number;
  spine: number;
  pageW: number;
  pageH: number;
}

function layoutFor(W: number, H: number): Layout {
  const bx0 = Math.round(W * 0.09);
  const by0 = Math.round(H * 0.09);
  const spine = Math.floor(W / 2);
  return { W, H, bx0, bx1: W - bx0, by0, by1: H - by0, spine, pageW: spine - bx0, pageH: H - 2 * by0 };
}

/** 페이지 n 의 왼쪽/오른쪽 무늬: 줄마다 길이·세로 위상이 n 에 따라 달라져 이웃 페이지와 확실히 다르다 */
function renderPattern(lay: Layout, n: number, side: 'left' | 'right', seed: number): RgbaImage {
  const w = lay.pageW;
  const h = lay.pageH;
  const img = createImage(w, h, PAPER_TONE);
  const rng = mulberry32(mixSeed(seed, n, side === 'left' ? 1 : 2));
  const mx = Math.round(w * 0.1);
  const my = Math.round(h * 0.1);
  const lines = 10;
  const pitch = (h - 2 * my) / lines;
  const thick = Math.max(2, Math.round(pitch * 0.4));
  // 길이 대역 5개를 페이지 번호만큼 돌려 쓴다 → 5페이지 이내에서는 같은 줄이 같은 대역에 놓이지 않는다
  const bands: Array<[number, number]> = [[0.25, 0.35], [0.4, 0.5], [0.55, 0.65], [0.7, 0.8], [0.85, 0.97]];
  const phase = (((n * 5) % 7) / 7) * pitch;
  const textW = w - 2 * mx;
  for (let i = 0; i < lines; i++) {
    const [lo, hi] = bands[(i + n + (side === 'right' ? 2 : 0)) % bands.length]!;
    const frac = lo + (hi - lo) * rng();
    const indent = rng() < 0.2 ? textW * 0.08 : 0;
    const y = my + phase + i * pitch;
    if (y + thick > h - my / 2) continue;
    fillRect(img, mx + indent, y, textW * frac, thick, INK_TONE);
  }
  // 3페이지에 한 번꼴로 그림 상자를 넣는다
  if ((n + (side === 'right' ? 1 : 0)) % 3 === 0) {
    fillRect(img, mx, my + pitch * 3, textW * 0.5, pitch * 2.4, [150, 150, 154]);
  }
  // 책등 쪽이 어두워지는 띠 (종이에 구워 둔다. 넘어가는 종이에서도 같이 움직인다)
  const sw = Math.max(2, w * 0.1);
  for (let x = 0; x < w; x++) {
    const d = side === 'left' ? w - 1 - x : x;
    const k = 1 - 0.38 * Math.exp(-((d / sw) ** 2));
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o]! * k;
      img.data[o + 1] = img.data[o + 1]! * k;
      img.data[o + 2] = img.data[o + 2]! * k;
    }
  }
  return img;
}

interface Ctx {
  lay: Layout;
  seed: number;
  cache: Map<string, RgbaImage>;
}

function patternOf(ctx: Ctx, n: number, side: 'left' | 'right'): RgbaImage {
  const key = `${n}${side}`;
  let img = ctx.cache.get(key);
  if (!img) {
    img = renderPattern(ctx.lay, n, side, ctx.seed);
    ctx.cache.set(key, img);
  }
  return img;
}

interface HandPose {
  x: number;
  y: number;
}

/** 손: 손바닥 + 손가락 네 개 + 엄지 + 팔뚝. (x, y) 는 손가락 끝 중심 */
function drawHand(img: RgbaImage, lay: Layout, h: HandPose): void {
  const s = lay.W / 160;
  const skin = (k: number): Rgb => [SKIN_TONE[0] * k, SKIN_TONE[1] * k, SKIN_TONE[2] * k];
  // 팔뚝 (화면 밖 오른쪽 아래로 이어진다)
  fillCapsule(img, h.x + 4 * s, h.y + 18 * s, h.x + 26 * s, h.y + 90 * s, 9 * s, skin(0.94));
  fillEllipse(img, h.x, h.y + 14 * s, 11 * s, 14 * s, skin(0.97));
  for (let k = 0; k < 4; k++) {
    const fx = h.x + (k - 1.5) * 5.2 * s;
    const lenTop = k === 0 || k === 3 ? 6 : 0;
    fillCapsule(img, fx, h.y + 6 * s, fx - (k - 1.5) * 0.6 * s, h.y + lenTop * s, 2.5 * s, skin(1));
  }
  fillCapsule(img, h.x - 9 * s, h.y + 18 * s, h.x - 17 * s, h.y + 8 * s, 2.8 * s, skin(1));
}

/** 종이 한 장이 책등을 축으로 넘어가는 중간 모습을 그린다 (p: 0 → 1) */
function drawLeaf(img: RgbaImage, lay: Layout, ctx: Ctx, from: number, p: number): void {
  const lift = Math.sin(Math.PI * p);
  const cosv = Math.cos(Math.PI * p);
  const w = Math.max(1, lay.pageW * Math.abs(cosv));
  const onRight = p < 0.5;
  const x0 = onRight ? lay.spine : lay.spine - w;
  const x1 = onRight ? lay.spine + w : lay.spine;
  const src = onRight ? patternOf(ctx, from, 'right') : patternOf(ctx, from + 1, 'left');
  const midY = lay.by0 + lay.pageH / 2;
  const tmp = new Float64Array(4);

  // 넘어가는 종이가 아래 페이지에 드리우는 그림자 (자유로운 가장자리 바깥쪽)
  const sw = Math.max(2, Math.round(lay.W * 0.03));
  for (let k = 0; k < sw; k++) {
    const x = onRight ? Math.round(x1) + k : Math.round(x0) - 1 - k;
    if (x < lay.bx0 || x >= lay.bx1) continue;
    const a = 0.3 * lift * (1 - k / sw);
    for (let y = lay.by0; y < lay.by1; y++) {
      const o = (y * lay.W + x) * 4;
      const m = 1 - a;
      img.data[o] = img.data[o]! * m;
      img.data[o + 1] = img.data[o + 1]! * m;
      img.data[o + 2] = img.data[o + 2]! * m;
    }
  }

  const xa = Math.floor(x0);
  const xb = Math.ceil(x1);
  for (let x = xa; x < xb; x++) {
    if (x < 0 || x >= lay.W) continue;
    const cx = x + 0.5;
    if (cx < x0 || cx > x1) continue;
    const u = (cx - x0) / w; // 종이 안에서 0..1
    const f = onRight ? u : 1 - u; // 0: 책등, 1: 자유로운 가장자리
    const sv = 1 + 0.12 * lift * f; // 자유 가장자리가 들려 올라와 세로로 커 보인다
    const shade = 1 - 0.22 * lift * f;
    const sx = u * src.width;
    const yTop = Math.max(0, Math.floor(midY - (lay.pageH / 2) * sv));
    const yBot = Math.min(lay.H, Math.ceil(midY + (lay.pageH / 2) * sv));
    for (let y = yTop; y < yBot; y++) {
      const sy = (y + 0.5 - midY) / sv + lay.pageH / 2;
      if (sy < 0 || sy >= src.height) continue;
      sampleBilinear(src, sx, sy, tmp);
      const o = (y * lay.W + x) * 4;
      img.data[o] = tmp[0]! * shade;
      img.data[o + 1] = tmp[1]! * shade;
      img.data[o + 2] = tmp[2]! * shade;
      img.data[o + 3] = 255;
    }
  }
}

interface FrameDesc {
  /** 보이는(또는 넘김 출발) 페이지 */
  page: number;
  /** 넘김 중이면 진행도 0..1 (0 과 1 밖이면 넘김 그리기 없음) */
  leaf?: number;
  hand?: HandPose;
  shake?: [number, number];
  blurRadius?: number;
}

function smooth(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return t * t * (3 - 2 * t);
}

function lerp(a: HandPose, b: HandPose, t: number): HandPose {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** 넘김 구간 안 진행도 q(0..1) → 종이 진행도·손 위치 */
function turnPose(lay: Layout, q: number): { leaf: number; hand: HandPose; done: boolean } {
  const grab: HandPose = { x: lay.bx1 - 0.02 * lay.W, y: lay.by0 + 0.72 * lay.pageH };
  const offIn: HandPose = { x: 1.2 * lay.W, y: 1.25 * lay.H };
  const offOut: HandPose = { x: -0.2 * lay.W, y: 1.25 * lay.H };
  if (q < 0.3) return { leaf: 0, hand: lerp(offIn, grab, smooth(q / 0.3)), done: false };
  if (q < 0.75) {
    const p = (q - 0.3) / 0.45;
    return {
      leaf: p,
      hand: { x: lay.spine + lay.pageW * Math.cos(Math.PI * p), y: grab.y - 0.08 * lay.H * Math.sin(Math.PI * p) },
      done: false,
    };
  }
  const end: HandPose = { x: lay.bx0, y: grab.y };
  return { leaf: 1, hand: lerp(end, offOut, smooth((q - 0.75) / 0.25)), done: true };
}

/** 손만 들어왔다 나가는 구간: 진행도 q(0..1) → 손 위치 */
function handOnlyPose(lay: Layout, q: number): HandPose {
  const hover: HandPose = { x: 0.62 * lay.W, y: 0.62 * lay.H };
  const off: HandPose = { x: 1.2 * lay.W, y: 1.25 * lay.H };
  if (q < 0.3) return lerp(off, hover, smooth(q / 0.3));
  if (q < 0.7) return { x: hover.x + 0.03 * lay.W * Math.sin(((q - 0.3) / 0.4) * Math.PI * 2), y: hover.y };
  return lerp(hover, off, smooth((q - 0.7) / 0.3));
}

function boxBlur(img: RgbaImage, r: number): RgbaImage {
  if (r <= 0) return img;
  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h * 3);
  const out = createImage(w, h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const o = (y * w + xx) * 4;
        a += img.data[o]!;
        b += img.data[o + 1]!;
        c += img.data[o + 2]!;
      }
      const t = (y * w + x) * 3;
      tmp[t] = a * norm;
      tmp[t + 1] = b * norm;
      tmp[t + 2] = c * norm;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const t = (yy * w + x) * 3;
        a += tmp[t]!;
        b += tmp[t + 1]!;
        c += tmp[t + 2]!;
      }
      const o = (y * w + x) * 4;
      out.data[o] = a * norm;
      out.data[o + 1] = b * norm;
      out.data[o + 2] = c * norm;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function shiftImage(img: RgbaImage, dx: number, dy: number): RgbaImage {
  const { width: w, height: h } = img;
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - dy));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      const so = (sy * w + sx) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = img.data[so]!;
      out.data[o + 1] = img.data[so + 1]!;
      out.data[o + 2] = img.data[so + 2]!;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function renderFrame(ctx: Ctx, d: FrameDesc, noiseSeed: number): RgbaImage {
  const { lay } = ctx;
  let img = createImage(lay.W, lay.H, DESK);
  const leafing = d.leaf !== undefined && d.leaf > 0 && d.leaf < 1;
  if (leafing) {
    // 아래층: 왼쪽은 이전 왼쪽 페이지, 오른쪽은 새 오른쪽 페이지. 그 위에 넘어가는 종이
    compositeOver(img, patternOf(ctx, d.page, 'left'), lay.bx0, lay.by0);
    compositeOver(img, patternOf(ctx, d.page + 1, 'right'), lay.spine, lay.by0);
    drawLeaf(img, lay, ctx, d.page, d.leaf!);
  } else {
    // 넘김이 끝난 프레임(leaf === 1)은 새 페이지(page + 1)를 그린다
    const n = d.leaf === 1 ? d.page + 1 : d.page;
    compositeOver(img, patternOf(ctx, n, 'left'), lay.bx0, lay.by0);
    compositeOver(img, patternOf(ctx, n, 'right'), lay.spine, lay.by0);
  }
  if (d.hand) drawHand(img, lay, d.hand);
  if (d.shake) img = shiftImage(img, d.shake[0], d.shake[1]);
  if (d.blurRadius) img = boxBlur(img, d.blurRadius);
  addNoise(img, mulberry32(noiseSeed), 1);
  return img;
}

/** 프레임을 하나씩 만든다 (메모리를 아끼려고 지연 생성). 같은 스크립트는 항상 같은 프레임을 낸다 */
export function* iterTurnFrames(script: TurnScript): Generator<SynthFrame, void, undefined> {
  const r = resolveScript(script);
  const lay = layoutFor(r.width, r.height);
  const ctx: Ctx = { lay, seed: r.seed, cache: new Map() };
  const shakeScale = Math.max(1, r.width / 160);
  const blurMax = Math.max(2, Math.round(r.height / 40));
  let index = 0;
  for (const seg of r.segments) {
    for (let i = 0; i < seg.frames; i++) {
      const q = (i + 0.5) / seg.frames;
      let desc: FrameDesc;
      if (seg.kind === 'still') {
        desc = { page: seg.page };
        if (i < seg.blurFrames) desc.blurRadius = Math.max(1, Math.ceil(blurMax * (1 - i / seg.blurFrames)));
      } else if (seg.kind === 'turn') {
        const pose = turnPose(lay, q);
        desc = { page: seg.from, leaf: pose.leaf, hand: pose.hand };
      } else if (seg.kind === 'hand') {
        desc = { page: seg.page, hand: handOnlyPose(lay, q) };
      } else {
        const rng = mulberry32(mixSeed(r.seed, index, 0x7368616b));
        // 1~3px(폭 160 기준) 흔들림. 해상도가 커지면 같은 비율로 키운다
        let kx = 0;
        let ky = 0;
        while (kx === 0 && ky === 0) {
          kx = Math.floor(rng() * 7) - 3;
          ky = Math.floor(rng() * 7) - 3;
        }
        const dx = Math.round(kx * shakeScale);
        const dy = Math.round(ky * shakeScale);
        desc = { page: seg.page, shake: [dx, dy] };
      }
      const img = renderFrame(ctx, desc, mixSeed(r.seed, index, 0x6e6f6973));
      yield { t: (index * 1000) / r.fps, width: lay.W, height: lay.H, rgba: img.data };
      index++;
    }
  }
}

/** 프레임 전체와 기대 촬영 횟수를 한 번에 돌려준다. 해상도를 크게 잡으면 메모리를 많이 쓰므로 영상 파일은 iterTurnFrames 를 쓴다 */
export function turnSequence(script: TurnScript): { frames: SynthFrame[]; expectedCaptures: number } {
  const plan = planTurns(script);
  return { frames: [...iterTurnFrames(script)], expectedCaptures: plan.expectedCaptures };
}

// ───────────────────────── Y4M ─────────────────────────

function fpsFraction(fps: number): string {
  return Number.isInteger(fps) ? `${fps}:1` : `${Math.round(fps * 1000)}:1000`;
}

/** Y4M 헤더 한 줄. 크롬 --use-file-for-fake-video-capture 가 읽는 4:2:0 */
export function y4mHeader(width: number, height: number, fps: number): string {
  return `YUV4MPEG2 W${width} H${height} F${fpsFraction(fps)} Ip A1:1 C420jpeg\n`;
}

/** RGBA → I420 (BT.601 제한 범위 Y 16..235, UV 16..240). 크롬의 I420 → RGB 변환과 같은 범위다 */
export function rgbaToI420(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const cw = width >> 1;
  const ch = height >> 1;
  const out = new Uint8Array(width * height + 2 * cw * ch);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[y * width + x] = 16 + (65.738 * rgba[o]! + 129.057 * rgba[o + 1]! + 25.064 * rgba[o + 2]!) / 256;
    }
  }
  const uBase = width * height;
  const vBase = uBase + cw * ch;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const o = ((cy * 2 + j) * width + cx * 2 + i) * 4;
          r += rgba[o]!;
          g += rgba[o + 1]!;
          b += rgba[o + 2]!;
        }
      }
      r /= 4;
      g /= 4;
      b /= 4;
      out[uBase + cy * cw + cx] = 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256;
      out[vBase + cy * cw + cx] = 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256;
    }
  }
  return out;
}

/**
 * Y4M 으로 저장한다. frames 는 배열이든 지연 생성기든 된다(프레임마다 바로 쓰고 버린다).
 * 가로·세로는 짝수여야 한다(4:2:0). 쓴 프레임 수와 바이트 수를 돌려준다.
 */
export function writeY4M(path: string, frames: Iterable<SynthFrame>, fps: number): { frames: number; bytes: number } {
  const fd = openSync(path, 'w');
  let count = 0;
  let bytes = 0;
  const write = (b: Uint8Array | string): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    bytes += buf.length;
  };
  try {
    let w = 0;
    let h = 0;
    for (const f of frames) {
      if (count === 0) {
        w = f.width;
        h = f.height;
        if (w % 2 !== 0 || h % 2 !== 0) throw new RangeError(`Y4M(4:2:0)은 가로·세로가 짝수여야 한다: ${w}x${h}`);
        write(y4mHeader(w, h, fps));
      } else if (f.width !== w || f.height !== h) {
        throw new RangeError('프레임 크기가 서로 다르다');
      }
      write('FRAME\n');
      write(rgbaToI420(f.rgba, w, h));
      count++;
    }
  } finally {
    closeSync(fd);
  }
  return { frames: count, bytes };
}
