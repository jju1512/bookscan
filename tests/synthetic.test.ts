/**
 * 합성 테스트 데이터 생성기 자체 검사. 무거운 전체 세트는 만들지 않고 작은 크기로만 돌린다.
 * (전체 세트는 `node tests/synthetic/generate.ts`)
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './synthetic/gen-video.ts';
import { renderOcr, SCENES } from './synthetic/generate.ts';
import {
  decodePng,
  createImage,
  encodePng,
  fillRect,
  mulberry32,
  sampleBilinear,
} from './synthetic/raster.ts';
import type { RgbaImage } from './synthetic/raster.ts';
import { renderScene } from './synthetic/scene.ts';
import type { Quad, SceneSpec } from './synthetic/scene.ts';
import { drawText, measureText } from './synthetic/text.ts';
import { iterTurnFrames, planTurns, rgbaToI420, turnSequence, writeY4M, y4mHeader } from './synthetic/frames.ts';
import type { SynthFrame, TurnScript } from './synthetic/frames.ts';

function quad(tl: [number, number], tr: [number, number], br: [number, number], bl: [number, number]): Quad {
  return [
    { x: tl[0], y: tl[1] },
    { x: tr[0], y: tr[1] },
    { x: br[0], y: br[1] },
    { x: bl[0], y: bl[1] },
  ];
}

/** 작은 펼침 장면 (페이지 300×420, 출력 520×380, 1샘플) */
function small(over: Partial<SceneSpec> = {}): SceneSpec {
  return {
    seed: 7,
    mode: 'spread',
    outWidth: 520,
    outHeight: 380,
    pageWidth: 300,
    pageHeight: 420,
    quad: quad([30, 30], [490, 22], [498, 356], [24, 360]),
    supersample: 1,
    ...over,
  };
}

function ycrcb(r: number, g: number, b: number): { y: number; cr: number; cb: number } {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return { y, cr: (r - y) * 0.713 + 128, cb: (b - y) * 0.564 + 128 };
}

describe('raster', () => {
  it('같은 시드의 난수열은 같고 시드가 다르면 다르다', () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    const c = mulberry32(6);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect([c(), c(), c()]).not.toEqual(xs);
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('PNG 로 저장했다 읽으면 픽셀이 그대로다', () => {
    const img = createImage(9, 7, [10, 20, 30]);
    fillRect(img, 2, 2, 3, 3, [200, 100, 50]);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(9);
    expect(back.height).toBe(7);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it('사각형 가장자리는 덮인 면적만큼만 섞는다 (안티앨리어싱)', () => {
    const img = createImage(4, 4, [0, 0, 0]);
    fillRect(img, 1.5, 1, 1, 1, [200, 200, 200]);
    expect(img.data[(1 * 4 + 1) * 4]).toBe(100);
    expect(img.data[(1 * 4 + 2) * 4]).toBe(100);
  });

  it('양선형 샘플링은 픽셀 중심에서 값을 그대로 돌려주고 중간에서 평균을 낸다', () => {
    const img = createImage(2, 1, [0, 0, 0]);
    img.data[4] = 100;
    const out = [0, 0, 0, 0];
    sampleBilinear(img, 0.5, 0.5, out);
    expect(out[0]).toBe(0);
    sampleBilinear(img, 1, 0.5, out);
    expect(out[0]).toBe(50);
  });
});

describe('text', () => {
  it('한글·영문·숫자를 그리고, 그린 폭은 측정 폭과 같다', () => {
    const img = createImage(260, 60, [244, 241, 232]);
    const w = drawText(img, '한글 Ab 12', 10, 40, 28, [20, 20, 20]);
    expect(w).toBeCloseTo(measureText('한글 Ab 12', 28), 6);
    let dark = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i]! < 80) dark++;
    expect(dark).toBeGreaterThan(100);
  });

  it('같은 입력은 같은 픽셀을 낸다', () => {
    const draw = (): RgbaImage => {
      const img = createImage(120, 40, [255, 255, 255]);
      drawText(img, '가나다', 5, 30, 24, [0, 0, 0]);
      return img;
    };
    expect(Array.from(draw().data)).toEqual(Array.from(draw().data));
  });
});

describe('scene', () => {
  it('같은 시드면 이미지와 정답이 같고, 시드가 다르면 달라진다', () => {
    const spec = small({ curve: 0.04, fingers: [{ edge: 'bottom', along: 0.3, reach: 0.2, radius: 14 }] });
    const a = renderScene(spec);
    const b = renderScene(spec);
    expect(Buffer.compare(Buffer.from(a.image.data), Buffer.from(b.image.data))).toBe(0);
    expect(JSON.stringify(a.truth)).toBe(JSON.stringify(b.truth));
    const c = renderScene({ ...spec, seed: 8 });
    expect(Buffer.compare(Buffer.from(a.image.data), Buffer.from(c.image.data))).not.toBe(0);
  });

  it('정답 사각형·책등이 출력 이미지 안에 있고, 평평하면 지정한 사각형과 같다', () => {
    const spec = small();
    const { truth } = renderScene(spec);
    expect(truth.bookQuad).toHaveLength(4);
    for (const [x, y] of truth.bookQuad) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(truth.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(truth.height);
    }
    spec.quad.forEach((p, i) => {
      expect(truth.bookQuad[i]![0]).toBeCloseTo(p.x, 1);
      expect(truth.bookQuad[i]![1]).toBeCloseTo(p.y, 1);
    });
    expect(truth.spine).not.toBeNull();
    for (const [x, y] of [truth.spine!.top, truth.spine!.bottom]) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(truth.width);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(truth.height);
    }
    // 책등은 책의 한가운데: 위·아래 점의 x 는 왼쪽·오른쪽 가장자리 사이에 있다
    expect(truth.spine!.top[0]).toBeGreaterThan(truth.bookQuad[0]![0]);
    expect(truth.spine!.top[0]).toBeLessThan(truth.bookQuad[1]![0]);
    expect(truth.pages.map((p) => p.side)).toEqual(['left', 'right']);
    expect(truth.lineCount).toBe(truth.lines.length);
    expect(truth.lineCount).toBeGreaterThan(5);
  });

  it('명세의 모든 장면 사각형이 출력 이미지 안에 들어간다 (그리지 않고 검사)', () => {
    for (const [name, spec] of Object.entries(SCENES)) {
      for (const p of spec.quad) {
        expect(p.x, name).toBeGreaterThanOrEqual(0);
        expect(p.x, name).toBeLessThanOrEqual(spec.outWidth);
        expect(p.y, name).toBeGreaterThanOrEqual(0);
        expect(p.y, name).toBeLessThanOrEqual(spec.outHeight);
      }
    }
  });

  it('휘어짐이 있으면 글자 줄 기준선이 직선에서 벗어나고, 없으면 직선이다', () => {
    const dev = (pts: Array<[number, number]>): number => {
      const [ax, ay] = pts[0]!;
      const [bx, by] = pts[pts.length - 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      return Math.max(...pts.map(([x, y]) => Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / len));
    };
    const flat = renderScene(small());
    const curved = renderScene(small({ curve: 0.045 }));
    // 왼쪽 페이지 첫 줄: 평평하면 직선, 휘면 직선에서 벗어나고 평평한 경우와 점 위치도 달라진다
    const lf = flat.truth.pages[0]!.lines[0]!.baseline;
    const lc = curved.truth.pages[0]!.lines[0]!.baseline;
    expect(dev(lf)).toBeLessThan(0.5);
    expect(dev(lc)).toBeGreaterThan(1);
    expect(Math.max(...lc.map((p, i) => Math.abs(p[1] - lf[i]![1])))).toBeGreaterThan(5);
    expect(curved.truth.curve.maxDisplacementPx).toBeCloseTo(0.045 * 420, 1);
  });

  it('손가락 픽셀이 YCrCb 피부 범위(Cr 140~165, Cb 95~120)에 든다', () => {
    const { image, truth } = renderScene(
      small({
        fingers: [
          { edge: 'left', along: 0.5, reach: 0.12, radius: 14 },
          { edge: 'bottom', along: 0.6, reach: 0.2, radius: 14 },
        ],
      }),
    );
    expect(truth.fingers).toHaveLength(2);
    let checked = 0;
    let inRange = 0;
    for (const f of truth.fingers) {
      const vx = f.base[0] - f.tip[0];
      const vy = f.base[1] - f.tip[1];
      const vl = Math.hypot(vx, vy);
      const ux = vx / vl;
      const uy = vy / vl;
      for (const d of [0, 0.5, 1, 1.5]) {
        for (const lat of [-0.5, 0, 0.5]) {
          const x = Math.round(f.tip[0] + ux * d * f.radius - uy * lat * f.radius);
          const y = Math.round(f.tip[1] + uy * d * f.radius + ux * lat * f.radius);
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
          const o = (y * image.width + x) * 4;
          const { cr, cb } = ycrcb(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!);
          checked++;
          if (cr >= 140 && cr <= 165 && cb >= 95 && cb <= 120) inRange++;
        }
      }
      // 경계 상자는 이미지 안
      expect(f.bbox.x).toBeGreaterThanOrEqual(0);
      expect(f.bbox.y).toBeGreaterThanOrEqual(0);
      expect(f.bbox.x + f.bbox.width).toBeLessThanOrEqual(truth.width + 0.01);
      expect(f.bbox.y + f.bbox.height).toBeLessThanOrEqual(truth.height + 0.01);
      expect(f.bbox.width).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(12);
    expect(inRange / checked).toBeGreaterThanOrEqual(0.95);
  });

  it('여백에만 있는 손가락은 글자를 덮지 않고, 깊이 들어온 손가락은 덮는다', () => {
    const margin = renderScene(small({ fingers: [{ edge: 'left', along: 0.5, reach: 0.03, radius: 14 }, { edge: 'right', along: 0.4, reach: 0.03, radius: 14 }] }));
    expect(margin.truth.fingers.map((f) => f.coversText)).toEqual([false, false]);
    const text = renderScene(small({ fingers: [{ edge: 'bottom', along: 0.3, reach: 0.3, radius: 14 }] }));
    expect(text.truth.fingers[0]!.coversText).toBe(true);
    expect(text.truth.fingers[0]!.coveredLines).toBeGreaterThan(0);
  });

  it('한 페이지 장면은 책등이 없고 페이지 하나만 정답에 든다', () => {
    const { truth } = renderScene(small({ mode: 'single', pageWidth: 300, outWidth: 380, outHeight: 500, quad: quad([40, 30], [340, 26], [346, 470], [34, 474]) }));
    expect(truth.kind).toBe('single');
    expect(truth.spine).toBeNull();
    expect(truth.pages).toHaveLength(1);
    expect(truth.pages[0]!.side).toBe('single');
  });

  it('그림 페이지는 글자 줄이 3개 이하다', () => {
    const { truth } = renderScene(
      small({
        pages: {
          left: {
            figure: { rect: { x: 30, y: 40, w: 240, h: 280 }, style: 'gradient' },
            lines: ['그림 1. 설명', '두 번째 줄'],
            firstBaselineY: 360,
            maxLines: 2,
          },
        },
      }),
    );
    expect(truth.pages[0]!.lineCount).toBeLessThanOrEqual(3);
    expect(truth.pages[1]!.lineCount).toBeGreaterThan(5);
  });
});

describe('ocr-ko', () => {
  it('1200×1600, 한국어 6줄 + 영어 1줄이고 정답 텍스트가 줄과 같다', () => {
    const { image, truth } = renderOcr();
    expect(image.width).toBe(1200);
    expect(image.height).toBe(1600);
    expect(truth.lines).toHaveLength(7);
    expect(truth.lines.filter((l) => l.lang === 'ko')).toHaveLength(6);
    expect(truth.lines.filter((l) => l.lang === 'en')).toHaveLength(1);
    expect(truth.text).toBe(truth.lines.map((l) => l.text).join('\n'));
    for (const l of truth.lines) expect(l.x1).toBeLessThanOrEqual(1100);
  });
});

// ───────────────────────── 프레임 시퀀스 ─────────────────────────

function luma(f: SynthFrame): Uint8Array {
  const out = new Uint8Array(f.width * f.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (f.rgba[j]! * 77 + f.rgba[j + 1]! * 150 + f.rgba[j + 2]! * 29) >> 8;
  }
  return out;
}

/** 밝기 차이가 25 를 넘는 픽셀의 비율 (SPEC 의 PIXEL_DIFF 와 같은 기준) */
function changed(a: SynthFrame, b: SynthFrame): number {
  const la = luma(a);
  const lb = luma(b);
  let n = 0;
  for (let i = 0; i < la.length; i++) if (Math.abs(la[i]! - lb[i]!) > 25) n++;
  return n / la.length;
}

/** 가로 방향 기울기 제곱합 (흐리면 작아진다) */
function sharp(f: SynthFrame): number {
  const l = luma(f);
  let s = 0;
  for (let y = 0; y < f.height; y++) {
    for (let x = 1; x < f.width; x++) {
      const d = l[y * f.width + x]! - l[y * f.width + x - 1]!;
      s += d * d;
    }
  }
  return s;
}

describe('turnSequence', () => {
  const base: TurnScript = { pages: 3, fps: 10, width: 80, height: 60, stillMs: 1000, turnMs: 500 };

  it('프레임 수와 기대 촬영 횟수가 계획과 맞다', () => {
    const { frames, expectedCaptures } = turnSequence(base);
    // 멈춤 3번 × 10프레임 + 넘김 2번 × 5프레임
    expect(frames).toHaveLength(40);
    expect(expectedCaptures).toBe(3);
    frames.forEach((f, i) => {
      expect(f.t).toBeCloseTo(i * 100, 6);
      expect(f.width).toBe(80);
      expect(f.height).toBe(60);
      expect(f.rgba).toHaveLength(80 * 60 * 4);
    });
  });

  it('이벤트: handOnly·shake·blur 는 기대 횟수를 늘리지 않고 slowTurn 은 세어 둔다', () => {
    const script: TurnScript = {
      ...base,
      pages: 4,
      events: [
        { kind: 'handOnly', afterPage: 1 },
        { kind: 'shake', afterPage: 2 },
        { kind: 'blur', afterPage: 2 },
        { kind: 'slowTurn', afterPage: 3 },
      ],
    };
    const plan = planTurns(script);
    expect(plan.expectedCaptures).toBe(4);
    expect(plan.slowTurnCount).toBe(1);
    expect(plan.pageStillStartMs).toHaveLength(4);
    const { frames } = turnSequence(script);
    expect(frames).toHaveLength(plan.totalFrames);
    // 이벤트가 없는 같은 길이보다 길다
    expect(plan.totalFrames).toBeGreaterThan(planTurns({ ...base, pages: 4 }).totalFrames);
  });

  it('잘못된 이벤트 위치는 거부한다', () => {
    expect(() => planTurns({ ...base, events: [{ kind: 'handOnly', afterPage: 9 }] })).toThrow(RangeError);
    expect(() => planTurns({ ...base, events: [{ kind: 'blur', afterPage: 3 }] })).toThrow(RangeError);
    expect(() => planTurns({ ...base, pages: 0 })).toThrow(RangeError);
  });

  it('같은 스크립트는 같은 프레임을 낸다', () => {
    const a = turnSequence({ ...base, events: [{ kind: 'shake', afterPage: 1 }] }).frames;
    const b = turnSequence({ ...base, events: [{ kind: 'shake', afterPage: 1 }] }).frames;
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) expect(Buffer.compare(Buffer.from(a[i]!.rgba), Buffer.from(b[i]!.rgba))).toBe(0);
    const c = turnSequence({ ...base, seed: 99 }).frames;
    expect(Buffer.compare(Buffer.from(a[0]!.rgba), Buffer.from(c[0]!.rgba))).not.toBe(0);
  });

  it('지연 생성기와 배열 결과가 같다', () => {
    const arr = turnSequence(base).frames;
    let i = 0;
    for (const f of iterTurnFrames(base)) {
      expect(f.t).toBe(arr[i]!.t);
      expect(Buffer.compare(Buffer.from(f.rgba), Buffer.from(arr[i]!.rgba))).toBe(0);
      i++;
    }
    expect(i).toBe(arr.length);
  });

  it('페이지마다 무늬가 확실히 다르다 (SPEC 의 CHANGE_MIN 8% 보다 충분히 크다)', () => {
    const script: TurnScript = { pages: 5, fps: 10, stillMs: 1000, turnMs: 500 };
    const { frames } = turnSequence(script);
    const plan = planTurns(script);
    const still = plan.pageStillStartMs.map((ms) => frames[Math.round(ms / 100) + 3]!);
    for (let i = 0; i < still.length; i++) {
      for (let j = i + 1; j < still.length; j++) {
        expect(changed(still[i]!, still[j]!), `${i} vs ${j}`).toBeGreaterThan(0.1);
      }
    }
  });

  it('멈춘 구간은 조용하고(노이즈만), 넘기는 구간은 크게 움직인다', () => {
    const script: TurnScript = { pages: 2, fps: 15, stillMs: 1000, turnMs: 700 };
    const { frames } = turnSequence(script);
    const plan = planTurns(script);
    const stillEnd = Math.round(plan.pageStillStartMs[1]! / (1000 / 15));
    let maxStill = 0;
    for (let i = 1; i < 15; i++) maxStill = Math.max(maxStill, changed(frames[i - 1]!, frames[i]!));
    expect(maxStill).toBeLessThan(0.005);
    let maxTurn = 0;
    let moving = 0;
    for (let i = 15; i < stillEnd; i++) {
      const c = changed(frames[i - 1]!, frames[i]!);
      maxTurn = Math.max(maxTurn, c);
      if (c > 0.05) moving++;
    }
    expect(maxTurn).toBeGreaterThan(0.05);
    // MOVE_MS 150ms(15fps 에서 2프레임 이상) 이상 MOVE 5% 를 넘긴다
    expect(moving).toBeGreaterThanOrEqual(3);
  });

  it('handOnly: 손이 보이는 동안 달라지지만 끝나면 같은 페이지로 돌아온다', () => {
    const script: TurnScript = { pages: 1, fps: 10, stillMs: 1000, turnMs: 600, events: [{ kind: 'handOnly', afterPage: 1 }] };
    const { frames } = turnSequence(script);
    // 멈춤 10 + 손 6 + 정착 5
    expect(frames).toHaveLength(21);
    let maxHand = 0;
    for (let i = 10; i < 16; i++) maxHand = Math.max(maxHand, changed(frames[9]!, frames[i]!));
    expect(maxHand).toBeGreaterThan(0.01);
    expect(changed(frames[9]!, frames[20]!)).toBeLessThan(0.005);
  });

  it('shake: 몇 프레임 동안 전체가 흔들리고 같은 페이지로 돌아온다', () => {
    const script: TurnScript = { pages: 1, fps: 10, stillMs: 1000, events: [{ kind: 'shake', afterPage: 1 }] };
    const { frames } = turnSequence(script);
    // 멈춤 10 + 흔들림 5 + 정착 5
    expect(frames).toHaveLength(20);
    let shaken = 0;
    for (let i = 10; i < 15; i++) if (changed(frames[9]!, frames[i]!) > 0.01) shaken++;
    expect(shaken).toBeGreaterThanOrEqual(3);
    expect(changed(frames[9]!, frames[19]!)).toBeLessThan(0.005);
  });

  it('blur: 새 페이지가 멈춘 직후는 흐리고 곧 선명해진다', () => {
    const script: TurnScript = { pages: 2, fps: 10, stillMs: 1000, turnMs: 500, events: [{ kind: 'blur', afterPage: 1 }] };
    const { frames } = turnSequence(script);
    const plan = planTurns(script);
    const start = Math.round(plan.pageStillStartMs[1]! / 100);
    const blurred = sharp(frames[start]!);
    const clear = sharp(frames[start + 6]!);
    expect(blurred).toBeLessThan(clear * 0.8);
    // 처음 페이지(블러 없음)는 처음부터 선명하다
    expect(sharp(frames[0]!)).toBeGreaterThan(clear * 0.9);
  });

  it('slowTurn: 프레임당 움직임이 작아 MOVE(5%)를 넘지 않는다', () => {
    const script: TurnScript = { pages: 2, fps: 10, stillMs: 500, turnMs: 500, events: [{ kind: 'slowTurn', afterPage: 1 }] };
    const { frames } = turnSequence(script);
    const plan = planTurns(script);
    expect(plan.slowTurnCount).toBe(1);
    const end = Math.round(plan.pageStillStartMs[1]! / 100);
    let maxStep = 0;
    for (let i = 6; i < end; i++) maxStep = Math.max(maxStep, changed(frames[i - 1]!, frames[i]!));
    expect(maxStep).toBeLessThan(0.05);
    expect(changed(frames[0]!, frames[end + 2]!)).toBeGreaterThan(0.1);
  });
});

describe('Y4M', () => {
  it('헤더 형식', () => {
    expect(y4mHeader(640, 480, 15)).toBe('YUV4MPEG2 W640 H480 F15:1 Ip A1:1 C420jpeg\n');
    expect(y4mHeader(160, 120, 12.5)).toBe('YUV4MPEG2 W160 H120 F12500:1000 Ip A1:1 C420jpeg\n');
  });

  it('흰색은 Y=235, U=V=128 로 바뀐다', () => {
    const w = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    const i420 = rgbaToI420(w, 4, 4);
    expect(i420).toHaveLength(16 + 4 + 4);
    expect(i420[0]).toBe(235);
    expect(i420[16]).toBe(128);
    expect(i420[20]).toBe(128);
  });

  it('파일에 헤더와 FRAME 구분자, 프레임 크기가 맞게 쓰인다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synth-y4m-'));
    try {
      const path = join(dir, 'a.y4m');
      const { frames } = turnSequence({ pages: 2, fps: 10, width: 32, height: 24, stillMs: 200, turnMs: 200 });
      const r = writeY4M(path, frames, 10);
      expect(r.frames).toBe(frames.length);
      const header = 'YUV4MPEG2 W32 H24 F10:1 Ip A1:1 C420jpeg\n';
      const frameBytes = 'FRAME\n'.length + 32 * 24 * 1.5;
      expect(statSync(path).size).toBe(header.length + frames.length * frameBytes);
      const buf = readFileSync(path);
      expect(buf.subarray(0, header.length).toString('latin1')).toBe(header);
      expect(buf.subarray(header.length, header.length + 6).toString('latin1')).toBe('FRAME\n');
      const second = header.length + frameBytes;
      expect(buf.subarray(second, second + 6).toString('latin1')).toBe('FRAME\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('가로·세로가 홀수이면 거부한다', () => {
    const f: SynthFrame = { t: 0, width: 5, height: 4, rgba: new Uint8ClampedArray(5 * 4 * 4) };
    const dir = mkdtempSync(join(tmpdir(), 'synth-y4m-'));
    try {
      expect(() => writeY4M(join(dir, 'b.y4m'), [f], 10)).toThrow(RangeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gen-video 인자', () => {
  it('출력 경로는 필수이고 옵션을 읽는다', () => {
    expect(() => parseArgs([])).toThrow('출력 경로');
    expect(() => parseArgs(['a.y4m', '--bogus'])).toThrow('알 수 없는 옵션');
    const r = parseArgs(['a.y4m', '--width', '320', '--height', '240', '--pages', '3', '--events', 'handOnly:1,slowTurn:2']);
    expect(r.script).toMatchObject({ width: 320, height: 240, pages: 3 });
    expect(r.script.events).toEqual([
      { kind: 'handOnly', afterPage: 1 },
      { kind: 'slowTurn', afterPage: 2 },
    ]);
    expect(() => parseArgs(['a.y4m', '--events', 'nope:1'])).toThrow('알 수 없는 이벤트');
  });
});
