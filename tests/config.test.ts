import { describe, expect, it } from 'vitest';
import { PARAM_DEFS, PARAM_KEYS, defaultParams, fromDisplay, toDisplay } from '../src/config/params';
import {
  STORAGE_KEY,
  loadParams,
  resetParams,
  sanitizeOverrides,
  saveParams,
  type KeyValueStorage,
} from '../src/config/store';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('기본 파라미터', () => {
  it('SPEC 6장 초기값과 같다 (% 값은 비율로 저장)', () => {
    const p = defaultParams();
    expect(p).toMatchObject({
      ANALYSIS_WIDTH: 320,
      ANALYSIS_FPS: 12,
      PIXEL_DIFF: 25,
      STILL: 0.005,
      MOVE: 0.05,
      MOVE_MS: 150,
      STABLE_MS: 400,
      CHANGE_MIN: 0.08,
      SHARP_RATIO: 0.8,
      MIN_INTERVAL_MS: 800,
    });
  });

  it('SPEC 8장 후처리 긴 변 최대값은 3000px', () => {
    expect(defaultParams().PROCESS_MAX_EDGE).toBe(3000);
  });

  it('모든 기본값이 자기 범위 안에 있다', () => {
    for (const key of PARAM_KEYS) {
      const d = PARAM_DEFS[key];
      expect(d.default, key).toBeGreaterThanOrEqual(d.min);
      expect(d.default, key).toBeLessThanOrEqual(d.max);
    }
  });

  it('% 값은 화면에 ×100 으로 보이고 되돌리면 원래 값이다', () => {
    expect(toDisplay('STILL', 0.005)).toBe(0.5);
    expect(fromDisplay('STILL', 0.5)).toBe(0.005);
    expect(toDisplay('CHANGE_MIN', 0.08)).toBe(8);
    expect(fromDisplay('CHANGE_MIN', 8)).toBe(0.08);
    expect(toDisplay('MOVE_MS', 150)).toBe(150);
  });
});

describe('파라미터 저장소', () => {
  it('저장소가 없으면 기본값', () => {
    expect(loadParams(undefined)).toEqual(defaultParams());
  });

  it('저장된 덮어쓰기 값을 불러온다', () => {
    const s = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ STILL: 0.01, MOVE_MS: 200 }) });
    const p = loadParams(s);
    expect(p.STILL).toBe(0.01);
    expect(p.MOVE_MS).toBe(200);
    expect(p.ANALYSIS_FPS).toBe(12);
  });

  it('깨진 JSON 이면 기본값', () => {
    const s = memoryStorage({ [STORAGE_KEY]: '{not json' });
    expect(loadParams(s)).toEqual(defaultParams());
  });

  it('getItem 이 던져도 기본값', () => {
    const s: KeyValueStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadParams(s)).toEqual(defaultParams());
  });

  it('모르는 키, 숫자가 아닌 값은 버리고 범위 밖 값은 자르며 정수 값은 반올림한다', () => {
    expect(
      sanitizeOverrides({ NOPE: 1, STILL: 'x', MOVE: Number.NaN, PIXEL_DIFF: 999, MOVE_MS: 150.6, CHANGE_MIN: -1 }),
    ).toEqual({ PIXEL_DIFF: 255, MOVE_MS: 151, CHANGE_MIN: 0 });
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([1, 2])).toEqual({});
  });

  it('기본값과 다른 값만 저장한다', () => {
    const s = memoryStorage();
    expect(saveParams(s, { ...defaultParams(), STABLE_MS: 500 })).toBe(true);
    expect(JSON.parse(s.map.get(STORAGE_KEY)!)).toEqual({ STABLE_MS: 500 });
  });

  it('모두 기본값이면 저장 항목을 지운다', () => {
    const s = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ STABLE_MS: 500 }) });
    expect(saveParams(s, defaultParams())).toBe(true);
    expect(s.map.has(STORAGE_KEY)).toBe(false);
  });

  it('setItem 이 던지면 false (용량 초과 등)', () => {
    const s: KeyValueStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    expect(saveParams(s, { STABLE_MS: 500 })).toBe(false);
  });

  it('초기화하면 기본값으로 돌아간다', () => {
    const s = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ STABLE_MS: 500 }) });
    expect(resetParams(s)).toBe(true);
    expect(loadParams(s)).toEqual(defaultParams());
  });
});
