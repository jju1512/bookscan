/**
 * 파라미터 저장·불러오기.
 *
 * 기본값은 params.ts 에 있고, 디버그 패널에서 바꾼 값 중 기본값과 다른 것만 저장한다.
 * localStorage 는 작은 설정값에만 쓴다 (SPEC 2장). 저장소가 없거나 막혀 있으면 기본값으로 동작한다.
 */
import { PARAM_DEFS, PARAM_KEYS, defaultParams, type ParamKey, type Params } from './params';

export const STORAGE_KEY = 'bookscan.params.v1';

/** localStorage 와 같은 모양. 테스트에서 가짜를 넣는다. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ParamOverrides = Partial<Record<ParamKey, number>>;

/**
 * 값 하나를 검사한다. 유한한 숫자가 아니면 undefined, 범위를 벗어나면 범위 안으로 자르고,
 * 정수 파라미터는 반올림한다.
 */
export function sanitizeValue(key: ParamKey, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const def = PARAM_DEFS[key];
  const clamped = Math.min(def.max, Math.max(def.min, value));
  return def.integer ? Math.round(clamped) : clamped;
}

/** 알 수 없는 키와 잘못된 값을 걸러 낸다. */
export function sanitizeOverrides(raw: unknown): ParamOverrides {
  const out: ParamOverrides = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const key of PARAM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const v = sanitizeValue(key, record[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function mergeParams(overrides: ParamOverrides): Params {
  return { ...defaultParams(), ...overrides };
}

export function loadOverrides(storage: KeyValueStorage | undefined): ParamOverrides {
  if (!storage) return {};
  try {
    const text = storage.getItem(STORAGE_KEY);
    if (!text) return {};
    return sanitizeOverrides(JSON.parse(text));
  } catch {
    return {};
  }
}

export function loadParams(storage: KeyValueStorage | undefined): Params {
  return mergeParams(loadOverrides(storage));
}

/**
 * 기본값과 다른 값만 저장한다. 저장에 실패하면 false.
 * 기본값과 같은 값은 저장하지 않으므로, 나중에 기본값이 바뀌면 새 기본값을 따른다.
 */
export function saveParams(storage: KeyValueStorage | undefined, params: ParamOverrides): boolean {
  if (!storage) return false;
  const defaults = defaultParams();
  const clean = sanitizeOverrides(params);
  const diff: ParamOverrides = {};
  for (const key of PARAM_KEYS) {
    const v = clean[key];
    if (v !== undefined && v !== defaults[key]) diff[key] = v;
  }
  try {
    if (Object.keys(diff).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(diff));
    return true;
  } catch {
    return false;
  }
}

export function resetParams(storage: KeyValueStorage | undefined): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 브라우저의 localStorage. 시크릿 모드 등에서 접근 자체가 막히면 undefined. */
export function browserStorage(): KeyValueStorage | undefined {
  try {
    const s = globalThis.localStorage;
    if (!s) return undefined;
    const probe = '__bookscan_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return undefined;
  }
}
