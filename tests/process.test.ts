/**
 * 후처리 단계 회귀 테스트 (SPEC 9장). 사용자 샘플이 아직 없어서 합성 이미지(tests/fixtures/synthetic)로 돌린다.
 * 정답(json)과 비교하고, 결과 이미지는 tests/fixtures/synthetic/out/ 에 써서 눈으로 볼 수 있게 한다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { cropPage, detectPageQuad, findSpine, subRaster, warpQuad } from '../src/process/crop/crop';
import { enhancePage } from '../src/process/enhance/enhance';
import { removeFingers, SKIN_CB, SKIN_CR } from '../src/process/finger/finger';
import type { Pt } from '../src/process/geom';
import type { CV, Raster } from '../src/process/raster';
import { fixture, loadCv, writeOut } from './helpers/cv';

let cv: CV;
beforeAll(async () => {
  cv = await loadCv();
}, 60_000);

/** 사각형 q → 단위 정사각형 호모그래피로 점 p 를 옮긴다 */
function mapToUnit(q: Pt[], p: Pt): Pt {
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 1, 0, 1, 1, 0, 1]);
  const M = cv.getPerspectiveTransform(from, to);
  const m = M.data64F as Float64Array;
  const d = m[6]! * p[0] + m[7]! * p[1] + m[8]!;
  const out: Pt = [(m[0]! * p[0] + m[1]! * p[1] + m[2]!) / d, (m[3]! * p[0] + m[4]! * p[1] + m[5]!) / d];
  from.delete();
  to.delete();
  M.delete();
  return out;
}

const maxCornerError = (a: Pt[], b: Pt[]) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1])));

function skinPixels(r: Raster): number {
  let n = 0;
  for (let i = 0; i < r.data.length; i += 4) {
    const R = r.data[i]!, G = r.data[i + 1]!, B = r.data[i + 2]!;
    const Y = 0.299 * R + 0.587 * G + 0.114 * B;
    const Cr = (R - Y) * 0.713 + 128;
    const Cb = (B - Y) * 0.564 + 128;
    if (Y > 40 && Cr >= SKIN_CR[0] && Cr <= SKIN_CR[1] && Cb >= SKIN_CB[0] && Cb <= SKIN_CB[1]) n++;
  }
  return n;
}

/** 정답 사각형으로 원근 보정·분할한 페이지 (손가락·보정 단계의 입력) */
function truthPage(name: string, side: 0 | 1): Raster {
  const { raster, truth } = fixture(name);
  const q = truth.pages[side].quad as Pt[];
  return warpQuad(cv, raster, [q[0]!, q[1]!, q[2]!, q[3]!]);
}

describe('자르기·분할', () => {
  for (const name of ['spread-flat', 'spread-perspective', 'spread-curved', 'spread-finger-margin']) {
    it(`${name}: 책 외곽 꼭짓점이 정답과 2% 안, 책등이 1.5% 안`, () => {
      const { raster, truth } = fixture(name);
      const d = detectPageQuad(cv, raster);
      expect(d, '사각형을 찾아야 한다').not.toBeNull();
      const err = maxCornerError(d!.corners, truth.bookQuad as Pt[]);
      expect(err / Math.max(raster.width, raster.height)).toBeLessThan(0.02);
      const left = cropPage(cv, raster, { side: 'left' });
      const right = cropPage(cv, raster, { side: 'right' });
      expect(left.found && right.found).toBe(true);
      // 책등: 정답 책등 두 점을 정답 외곽 → 직사각형 호모그래피로 옮긴 x 비율
      const bq = truth.bookQuad as Pt[];
      const sp = truth.spine as { top: Pt; bottom: Pt };
      const spineT = (mapToUnit(bq, sp.top)[0] + mapToUnit(bq, sp.bottom)[0]) / 2;
      expect(Math.abs(left.splitX! - spineT)).toBeLessThan(0.015);
      expect(left.raster.width + right.raster.width).toBeGreaterThan(raster.width * 0.6);
      writeOut(`crop-${name}-left`, left.raster);
      writeOut(`crop-${name}-right`, right.raster);
    });
  }

  it('한 페이지 사진도 외곽을 찾는다', () => {
    const { raster, truth } = fixture('page-flat');
    const r = cropPage(cv, raster, { side: 'single' });
    expect(r.found).toBe(true);
    const quad = (truth.pageQuad ?? truth.bookQuad) as Pt[];
    const pts: Pt[] = [0, 1, 2, 3].map((i) => [r.corners[i * 2]! * raster.width, r.corners[i * 2 + 1]! * raster.height]);
    expect(maxCornerError(pts, quad) / raster.width).toBeLessThan(0.02);
  });

  it('책이 없는 사진은 실패로 알리고 원본을 그대로 쓴다 (수동 보정 대상)', () => {
    // 가장자리도 밝기 차이도 없는 평평한 사진
    const w = 400, h = 300;
    const data = new Uint8ClampedArray(w * h * 4).fill(128);
    const r = cropPage(cv, { width: w, height: h, data }, { side: 'single' });
    expect(r.found).toBe(false);
    expect(r.method).toBe('none');
    expect(r.raster.width).toBe(w);
    expect(r.note).toMatch('수동 보정');
  });

  it('수동 보정값(꼭짓점·분할선)이 있으면 검출 없이 그 값을 쓴다', () => {
    const { raster } = fixture('spread-flat');
    const r = cropPage(cv, raster, { side: 'right', manual: { corners: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9], splitX: 0.3 } });
    expect(r.method).toBe('manual');
    expect(r.splitX).toBe(0.3);
    expect(r.raster.width).toBeCloseTo(raster.width * 0.8 * 0.7, -1);
  });

  it('findSpine: 가운데 어두운 세로줄', () => {
    const w = 200, h = 50;
    const data = new Uint8ClampedArray(w * h * 4).fill(230);
    for (let y = 0; y < h; y++) for (const x of [108, 109, 110]) data.fill(40, (y * w + x) * 4, (y * w + x) * 4 + 3);
    expect(findSpine({ width: w, height: h, data })).toBeCloseTo(109 / 200, 2);
    expect(subRaster({ width: w, height: h, data }, 50, 120).width).toBe(70);
  });
});

describe('손가락 지우기', () => {
  it('여백의 손가락은 지우고(피부색 픽셀 90% 이상 감소) 글자 덮음 표시는 하지 않는다', () => {
    const { truth } = fixture('spread-finger-margin');
    let before = 0, after = 0;
    for (const side of [0, 1] as const) {
      const page = truthPage('spread-finger-margin', side);
      const r = removeFingers(cv, page);
      before += skinPixels(page);
      after += skinPixels(r.raster);
      expect(r.overText).toBe(false);
      writeOut(`finger-margin-${side}`, r.raster);
    }
    expect((truth.fingers as unknown[]).length).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(500);
    expect(after).toBeLessThan(before * 0.1);
  });

  it('본문 글자를 덮은 손가락은 지우지 않고 표시만 한다', () => {
    const { truth } = fixture('spread-finger-text');
    const sides = (truth.fingers as { coversText: boolean; bbox: { x: number } }[]).filter((f) => f.coversText).map((f) => (f.bbox.x < truth.width / 2 ? 0 : 1));
    expect(sides.length).toBeGreaterThan(0);
    let flagged = false;
    for (const side of new Set(sides)) {
      const page = truthPage('spread-finger-text', side as 0 | 1);
      const r = removeFingers(cv, page);
      if (r.overText) flagged = true;
      for (const reg of r.regions.filter((x) => x.action === 'overText')) expect(reg.area).toBeGreaterThan(0);
      writeOut(`finger-text-${side}`, r.raster);
    }
    expect(flagged).toBe(true);
  });

  it('자동 자르기 결과에서도: 여백 손가락은 "덮음"으로 잘못 표시하지 않고, 글자 위 손가락은 표시한다', () => {
    const flags = (name: string) =>
      (['left', 'right'] as const).map((side) => removeFingers(cv, cropPage(cv, fixture(name).raster, { side }).raster).overText);
    expect(flags('spread-finger-margin')).toEqual([false, false]);
    expect(flags('spread-finger-text')).toContain(true);
  });

  it('손가락이 없으면 바꾸지 않는다', () => {
    const r = removeFingers(cv, truthPage('spread-flat', 0));
    expect(r.changed).toBe(false);
    expect(r.regions).toHaveLength(0);
  });
});

describe('화질 보정', () => {
  it('배경이 흰색에 가까워지고(240 이상) 글자는 어둡게 남는다', () => {
    const page = truthPage('spread-perspective', 1);
    const r = enhancePage(cv, page);
    expect(r.backgroundAfter).toBeGreaterThanOrEqual(240);
    expect(r.backgroundAfter).toBeGreaterThan(r.backgroundBefore);
    let dark = 0;
    for (let i = 0; i < r.raster.data.length; i += 4) if (r.raster.data[i]! < 100) dark++;
    expect(dark / (r.raster.data.length / 4)).toBeGreaterThan(0.005);
    writeOut('enhance-perspective-right', r.raster);
  });

  it('흑백 옵션은 0 과 255 만 남긴다', () => {
    const r = enhancePage(cv, truthPage('spread-flat', 0), { binarize: true });
    const vals = new Set<number>();
    for (let i = 0; i < r.raster.data.length; i += 4 * 17) vals.add(r.raster.data[i]!);
    expect([...vals].every((v) => v === 0 || v === 255)).toBe(true);
  });
});
