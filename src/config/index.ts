/**
 * 런타임 파라미터의 단일 진입점.
 * 다른 모듈은 파라미터를 이 파일의 getParams()/setParams() 로만 읽고 쓴다.
 */
import { defaultParams, type Params } from './params';
import { browserStorage, loadParams, resetParams, saveParams, type ParamOverrides } from './store';

export * from './params';

type Listener = (params: Params) => void;

let current: Params = defaultParams();
const listeners = new Set<Listener>();

/** 앱 시작 시 한 번 부른다. 저장된 값을 불러온다. */
export function initParams(): Params {
  current = loadParams(browserStorage());
  return current;
}

export function getParams(): Params {
  return current;
}

/**
 * 값을 바꾸고 저장한다. 반환값은 저장 성공 여부.
 * 저장에 실패해도(저장소 없음) 이번 세션에는 검사한 값이 적용된다.
 */
export function setParams(next: ParamOverrides): boolean {
  const storage = browserStorage();
  const merged = { ...current, ...next };
  const ok = saveParams(storage, merged);
  current = ok ? loadParams(storage) : loadParams(memoryOf(merged));
  emit();
  return ok;
}

export function resetAllParams(): void {
  resetParams(browserStorage());
  current = defaultParams();
  emit();
}

export function onParamsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn(current);
}

/** 저장소가 없을 때도 같은 검사 규칙을 거치도록 메모리 저장소를 만든다. */
function memoryOf(params: ParamOverrides) {
  const map = new Map<string, string>();
  const mem = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  saveParams(mem, params);
  return mem;
}
