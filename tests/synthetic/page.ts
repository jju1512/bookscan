/**
 * 평평한 책 페이지 한 장을 그린다 (종이색 + 여백 + 본문 줄 + 선택적 그림 영역).
 * 줄마다 기준선 y 와 x 범위를 돌려줘서, 장면 합성과 정답(ground truth) 계산이 그대로 쓴다.
 */
import { addNoise, createImage, fillEllipse, fillRect, mulberry32, mixSeed } from './raster.ts';
import type { Rgb, RgbaImage } from './raster.ts';
import { drawText, measureText } from './text.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageLine {
  text: string;
  /** 'ko' 한글이 있는 줄, 'en' 그 밖의 줄 */
  lang: 'ko' | 'en';
  baselineY: number;
  x0: number;
  x1: number;
  sizePx: number;
}

export type FigureStyle = 'gray' | 'gradient';

export interface PageSpec {
  width: number;
  height: number;
  /** 책등이 어느 쪽에 있는가. left 쪽 페이지는 책등이 오른쪽, right 쪽 페이지는 왼쪽이다 */
  side: 'left' | 'right' | 'single';
  seed: number;
  /** 글자 크기(px). 기본 24 */
  sizePx?: number;
  /** 줄 간격(px). 기본 sizePx × 1.75 */
  lineHeight?: number;
  margins?: { top: number; bottom: number; outer: number; inner: number };
  /** 본문 말뭉치에서 몇 번째 문단부터 쓸지 (페이지마다 다른 글이 나오게 한다) */
  paragraphStart?: number;
  /** 줄 수 상한 */
  maxLines?: number;
  /** 문단 나누기 없이 이 줄들을 그대로 순서대로 쓴다 (OCR 정답용·그림 설명용) */
  lines?: string[];
  /** 그림 영역. 겹치는 줄 자리는 비운다 */
  figure?: { rect: Rect; style: FigureStyle };
  /** 줄이 놓일 첫 기준선 y. 기본 위 여백 + 글자 크기 */
  firstBaselineY?: number;
  /** 종이 노이즈 표준편차. 기본 0.3 (PNG 크기를 10MB 안에 두려고 약하게) */
  noise?: number;
  /** 종이색. 기본 #f4f1e8 */
  paper?: Rgb;
  /** 글자색. 기본 어두운 회색 */
  ink?: Rgb;
}

export interface PageRender {
  image: RgbaImage;
  lines: PageLine[];
  /** 본문이 놓이는 영역(여백 안쪽) */
  textRect: Rect;
  figure?: Rect;
}

export const PAPER: Rgb = [244, 241, 232];
export const INK: Rgb = [28, 28, 32];

/** 본문 말뭉치. 한국어 문단 사이에 영어 문단을 섞어 둔다 (직접 쓴 문장이라 저작권 문제가 없다) */
export const CORPUS: readonly string[] = [
  '책을 펼쳐 놓고 한 장씩 넘기면 카메라가 알아서 사진을 찍어 주는 방식은 생각보다 간단하다. 화면이 크게 움직이다가 다시 멈추는 순간을 찾고, 그때의 장면이 직전과 다른지만 확인하면 된다.',
  '오래된 도서관의 서가 사이로 오후의 햇살이 길게 들어왔다. 먼지가 천천히 떠다니는 것을 바라보며 그는 낡은 책의 표지를 조심스럽게 쓸어 보았다.',
  'The quick brown fox jumps over the lazy dog. Scanning a book page by page with a phone and a small stand is slower than a flatbed scanner but far more convenient.',
  '종이의 가장자리가 휘어지면 글자 줄도 따라서 휘어 보인다. 이것을 바로잡으려면 먼저 줄의 방향을 찾아야 하고, 그다음에 페이지 전체를 하나의 매끄러운 곡면으로 설명해야 한다.',
  '겨울 아침에는 창문에 성에가 끼고 부엌에서는 보리차 끓는 냄새가 났다. 어머니는 말없이 따뜻한 수건을 건네주셨고, 우리는 그것으로 손을 녹이며 하루를 시작했다.',
  '손가락이 페이지의 가장자리를 누르고 있으면 그 부분은 사진에서 피부색으로 나타난다. 여백에 있는 손가락은 종이 색으로 덮으면 되지만 글자를 가린 경우에는 어떤 방법으로도 복원할 수 없다.',
  'Reading is to the mind what exercise is to the body. A good book can change the way we see the world, and a good scan lets us keep it forever on a shelf that never runs out of room.',
  '시장 골목의 끝에는 작은 책방이 있었다. 주인은 손님이 들어와도 인사 없이 신문만 넘겼지만, 찾는 책이 있다고 하면 어느새 서가 깊은 곳에서 그 책을 꺼내 오곤 했다.',
  '문자 인식은 글자가 또렷할수록 정확해진다. 그래서 사진을 찍을 때는 흔들림이 없어야 하고, 조명이 고르게 퍼져야 하며, 책등 근처의 그림자도 되도록 옅은 편이 좋다.',
  '강물은 산을 돌아 천천히 내려가다가 넓은 들에서 속도를 늦춘다. 그 곁을 따라 걷다 보면 계절마다 다른 풀꽃이 피어 있고, 물 위에는 구름이 느리게 지나간다.',
  '실험은 같은 조건에서 여러 번 반복해야 믿을 수 있다. 한 번 잘 나온 결과는 우연일 수 있기 때문에, 정답을 아는 합성 데이터와 실제 사진을 함께 써서 개선 정도를 확인한다.',
  '저녁 무렵 기차역 광장에는 여행 가방을 끄는 사람들로 붐볐다. 전광판의 숫자가 바뀔 때마다 사람들의 고개가 한꺼번에 위를 향했다가, 곧 다시 각자의 걸음으로 흩어졌다.',
];

function hasHangul(s: string): boolean {
  return /[ㄱ-ㆎ가-힣]/.test(s);
}

/** 공백 기준 탐욕적 줄바꿈. 첫 줄은 indent 만큼 들여 쓴다 */
function wrapParagraph(text: string, sizePx: number, maxWidth: number, indent: number): Array<{ text: string; indent: number }> {
  const words = text.split(' ');
  const out: Array<{ text: string; indent: number }> = [];
  let cur = '';
  let curIndent = indent;
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (cur && measureText(trial, sizePx) + curIndent > maxWidth) {
      out.push({ text: cur, indent: curIndent });
      cur = w;
      curIndent = 0;
    } else {
      cur = trial;
    }
  }
  if (cur) out.push({ text: cur, indent: curIndent });
  return out;
}

/** 위아래·좌우로 매끄럽게 변하는 종이 밝기 (가장자리가 약간 어두운 비네팅) */
function paintPaper(img: RgbaImage, paper: Rgb, rng: () => number, noise: number): void {
  const { width: w, height: h, data } = img;
  const phase = rng() * Math.PI * 2;
  for (let y = 0; y < h; y++) {
    const ny = (y / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const nx = (x / w) * 2 - 1;
      const shade = 1 - 0.035 * (nx * nx + ny * ny) + 0.008 * Math.sin(phase + nx * 2.1 + ny * 1.3);
      const i = (y * w + x) * 4;
      data[i] = paper[0] * shade;
      data[i + 1] = paper[1] * shade;
      data[i + 2] = paper[2] * shade;
      data[i + 3] = 255;
    }
  }
  addNoise(img, rng, noise);
}

/** 그림 영역: 회색 바탕 + 가로 그라데이션 + 단순한 도형 몇 개 + 테두리 */
function paintFigure(img: RgbaImage, r: Rect, style: FigureStyle, rng: () => number): void {
  const x0 = Math.floor(r.x);
  const y0 = Math.floor(r.y);
  const x1 = Math.ceil(r.x + r.w);
  const y1 = Math.ceil(r.y + r.h);
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const u = (x - r.x) / r.w;
      const v = (y - r.y) / r.h;
      const g = style === 'gray' ? 150 + 12 * Math.sin(v * 9) : 70 + 150 * (0.65 * u + 0.35 * v);
      const i = (y * img.width + x) * 4;
      img.data[i] = g;
      img.data[i + 1] = g;
      img.data[i + 2] = g * 0.98;
      img.data[i + 3] = 255;
    }
  }
  // 그림 안의 도형 (밝기 차이가 있어야 경계가 보인다)
  const n = 3 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const cx = r.x + r.w * (0.15 + 0.7 * rng());
    const cy = r.y + r.h * (0.15 + 0.7 * rng());
    const rx = r.w * (0.05 + 0.12 * rng());
    const ry = r.h * (0.04 + 0.1 * rng());
    const tone = 40 + Math.floor(rng() * 150);
    if (rng() < 0.5) fillEllipse(img, cx, cy, rx, ry, [tone, tone, tone], 0.85);
    else fillRect(img, cx - rx, cy - ry, rx * 2, ry * 2, [tone, tone, tone], 0.85);
  }
  const edge: Rgb = [60, 60, 60];
  fillRect(img, r.x, r.y, r.w, 2, edge);
  fillRect(img, r.x, r.y + r.h - 2, r.w, 2, edge);
  fillRect(img, r.x, r.y, 2, r.h, edge);
  fillRect(img, r.x + r.w - 2, r.y, 2, r.h, edge);
}

export function drawPage(spec: PageSpec): PageRender {
  const { width, height } = spec;
  const sizePx = spec.sizePx ?? 24;
  const lineHeight = spec.lineHeight ?? sizePx * 1.75;
  const m = spec.margins ?? {
    top: Math.round(height * 0.08),
    bottom: Math.round(height * 0.08),
    outer: Math.round(width * 0.1),
    inner: Math.round(width * 0.13),
  };
  const rng = mulberry32(mixSeed(spec.seed, 0x70616765));
  const img = createImage(width, height, spec.paper ?? PAPER);
  paintPaper(img, spec.paper ?? PAPER, rng, spec.noise ?? 0.3);

  // 책등 쪽 여백(inner)과 바깥쪽 여백(outer)을 좌우로 배분한다
  const left = spec.side === 'left' ? m.outer : spec.side === 'right' ? m.inner : m.outer;
  const right = spec.side === 'left' ? m.inner : spec.side === 'right' ? m.outer : m.outer;
  const textRect: Rect = { x: left, y: m.top, w: width - left - right, h: height - m.top - m.bottom };

  let figure: Rect | undefined;
  if (spec.figure) {
    figure = spec.figure.rect;
    paintFigure(img, figure, spec.figure.style, rng);
  }

  // 놓을 줄 목록: 명시된 줄이 있으면 그대로, 없으면 말뭉치를 줄바꿈해서 만든다
  const queue: Array<{ text: string; indent: number }> = [];
  const need = Math.ceil(textRect.h / lineHeight) + 2;
  if (spec.lines) {
    for (const t of spec.lines) queue.push({ text: t, indent: 0 });
  } else {
    let p = spec.paragraphStart ?? 0;
    while (queue.length < need) {
      const para = CORPUS[p % CORPUS.length]!;
      queue.push(...wrapParagraph(para, sizePx, textRect.w, hasHangul(para) ? sizePx : 0));
      p++;
    }
  }

  const ink = spec.ink ?? INK;
  const lines: PageLine[] = [];
  const maxLines = spec.maxLines ?? Infinity;
  let baseline = spec.firstBaselineY ?? textRect.y + sizePx;
  const bottomLimit = textRect.y + textRect.h;
  const pad = lineHeight * 0.4;
  let qi = 0;
  while (qi < queue.length && lines.length < maxLines && baseline <= bottomLimit) {
    // 그림 영역(여유 포함)과 겹치는 줄 자리는 비우고 다음 자리로 간다. 글은 소비하지 않는다
    if (figure && baseline - sizePx < figure.y + figure.h + pad && baseline + sizePx * 0.3 > figure.y - pad) {
      baseline += lineHeight;
      continue;
    }
    const item = queue[qi++]!;
    const x0 = textRect.x + item.indent;
    const [r, g, b] = ink;
    const tone = (rng() - 0.5) * 10;
    const w = drawText(img, item.text, x0, baseline, sizePx, [r + tone, g + tone, b + tone]);
    lines.push({ text: item.text, lang: hasHangul(item.text) ? 'ko' : 'en', baselineY: baseline, x0, x1: x0 + w, sizePx });
    baseline += lineHeight;
  }
  return { image: img, lines, textRect, ...(figure ? { figure } : {}) };
}
