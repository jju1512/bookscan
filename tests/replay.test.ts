/**
 * 녹화 영상 재생 테스트 (SPEC 9장). 실제 녹화가 아직 없어서 합성 페이지 넘김 프레임으로
 * 실제 촬영과 같은 분석기(FrameAnalyzer) + 상태 머신(ReplayRunner)을 돌린다.
 * 사용자가 녹화한 영상이 생기면 tests/fixtures/ 에 넣고 같은 방식으로 기대 횟수를 적는다.
 */
import { describe, expect, it } from 'vitest';
import { rgbaToGray } from '../src/capture/analysis';
import { ReplayRunner } from '../src/capture/replay';
import { defaultParams } from '../src/config/params';
import { turnSequence, type TurnScript } from './synthetic/frames.ts';

function replay(script: TurnScript, params = defaultParams()) {
  const { frames, expectedCaptures } = turnSequence(script);
  const runner = new ReplayRunner(params);
  for (const f of frames) runner.push(rgbaToGray(f.rgba, f.width, f.height), f.t);
  return { captures: runner.result.captures, expectedCaptures };
}

describe('합성 페이지 넘김 재생', () => {
  it('6페이지를 넘기면 6장 (누락·중복 없음)', () => {
    const r = replay({ pages: 6, fps: 12, seed: 3 });
    expect(r.captures).toHaveLength(r.expectedCaptures);
    expect(r.expectedCaptures).toBe(6);
  });

  it('손만 움직이면 추가 촬영이 없다', () => {
    const r = replay({ pages: 4, fps: 12, seed: 5, events: [{ kind: 'handOnly', afterPage: 1 }] });
    expect(r.captures).toHaveLength(r.expectedCaptures);
  });

  it('흔들림은 넘김으로 보지 않는다', () => {
    const r = replay({ pages: 4, fps: 12, seed: 7, events: [{ kind: 'shake', afterPage: 2 }] });
    expect(r.captures).toHaveLength(r.expectedCaptures);
  });

  it('넘긴 직후 흐린 프레임이 있어도 한 번만 찍는다', () => {
    const r = replay({ pages: 4, fps: 12, seed: 9, events: [{ kind: 'blur', afterPage: 1 }] });
    expect(r.captures).toHaveLength(r.expectedCaptures);
  });

  it('파라미터를 바꾸면 촬영 시점이 달라진다 (튜닝 도구의 전제)', () => {
    const base = replay({ pages: 4, fps: 12, seed: 3 });
    const strict = replay({ pages: 4, fps: 12, seed: 3 }, { ...defaultParams(), CHANGE_MIN: 0.99 });
    expect(strict.captures.length).toBeLessThan(base.captures.length);
  });
});
