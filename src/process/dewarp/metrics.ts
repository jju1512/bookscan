/**
 * 글자 줄의 곧음 측정 (시험·디버그용).
 * 같은 글자 줄 검출(detect.ts, spans.ts)을 이미지에 적용해, 줄마다 점들을 직선(y = a + b·x)에 최소제곱으로 맞추고
 * 그 잔차의 RMS 를 구한다. 줄이 곧고 기울기만 있으면 0 에 가깝고, 휘어 있으면 커진다.
 * 값은 작업 이미지의 긴 변에 대한 천분율(‰)로 낸다. 기울어진 이미지끼리도 비교된다.
 * 점은 잉크의 열별 세로 평균(글자 모양에 따라 흔들림)이라 완전히 곧은 줄도 0 이 되지는 않는다 (바닥 잡음).
 */
import type { CV, Raster } from '../raster';
import { selectWorkScale, WORK_EDGES } from './detect';
import { sampleSpans } from './spans';

export interface Straightness {
  /** 직선 맞춤 잔차 RMS (‰, 점 수 가중). 줄이 없으면 NaN */
  rmsPermille: number;
  spans: number;
  points: number;
  /** 쓴 작업 해상도의 긴 변 */
  workEdge: number;
}

/**
 * workEdge 를 주면 그 해상도 하나로, 안 주면 펴기와 같은 방식으로 후보 중에서 고른다.
 * 펴기 전·후 이미지는 크기가 달라서, 글자 크기를 맞추려면 후 이미지에는 (전 작업 해상도 × 후 긴 변 / 전 긴 변)을 주면 된다.
 */
export function measureStraightness(cv: CV, r: Raster, workEdge?: number): Straightness {
  const { g, spans } = selectWorkScale(cv, r, workEdge ? [workEdge] : WORK_EDGES);
  const lines = sampleSpans(spans).filter((s) => s.length >= 6);
  let rss = 0;
  let n = 0;
  for (const pts of lines) {
    const m = pts.length;
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p[0];
      sy += p[1];
    }
    const mx = sx / m;
    const my = sy / m;
    let sxx = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += (p[0] - mx) ** 2;
      sxy += (p[0] - mx) * (p[1] - my);
    }
    const b = sxx > 0 ? sxy / sxx : 0;
    for (const p of pts) {
      const e = p[1] - (my + b * (p[0] - mx));
      rss += e * e;
    }
    n += m;
  }
  const long = Math.max(g.width, g.height);
  return { rmsPermille: n > 0 ? (Math.sqrt(rss / n) / long) * 1000 : NaN, spans: lines.length, points: n, workEdge: long };
}
