/**
 * 숫자가 아닌 사용자 설정 (촬영 방식, 단계 켜고 끄기, 드라이브 연동 여부 등).
 * 튜닝 숫자는 params.ts, 이 파일은 고르는 값만 둔다. 작은 값이라 localStorage 에 둔다 (SPEC 2장).
 * 토큰은 절대 여기 두지 않는다 (SPEC 7장: 메모리에만).
 */
import type { ProcessStepName } from '../storage/types';
import { browserStorage, type KeyValueStorage } from './store';

export const SETTINGS_KEY = 'bookscan.settings.v1';

export type CaptureMethod = 'auto' | 'photo' | 'frame';

export interface Settings {
  /** auto: takePhoto 를 쓰다가 1초를 넘기거나 미리보기가 끊기면 스트림 프레임으로 바꾼다 */
  captureMethod: CaptureMethod;
  shutterSound: boolean;
  vibrate: boolean;
  defaultCaptureMode: 'spread' | 'single';
  /** 후처리 단계 켜고 끄기 */
  steps: Record<ProcessStepName, boolean>;
  /** 화질 보정의 적응형 임계값 흑백 변환 */
  enhanceBinarize: boolean;
  /** "로컬 정리" 옵션을 보일지 (기본 꺼짐, SPEC 4장 규칙 7) */
  localCleanup: boolean;
  /** 사용자가 드라이브 연동을 골랐다 (토큰은 메모리에만 있고, 다음 실행 때 다시 받는다) */
  driveEnabled: boolean;
  /** 온보딩 질문에 답했다 */
  onboardingDone: boolean;
}

export function defaultSettings(): Settings {
  return {
    captureMethod: 'auto',
    shutterSound: true,
    vibrate: true,
    defaultCaptureMode: 'spread',
    steps: { crop: true, finger: true, dewarp: true, enhance: true, ocr: true },
    enhanceBinarize: false,
    localCleanup: false,
    driveEnabled: false,
    onboardingDone: false,
  };
}

export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  const bool = (k: keyof Settings, def: boolean) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : def);
  const steps = { ...d.steps };
  if (r.steps && typeof r.steps === 'object') {
    for (const k of Object.keys(steps) as ProcessStepName[]) {
      const v = (r.steps as Record<string, unknown>)[k];
      if (typeof v === 'boolean') steps[k] = v;
    }
  }
  return {
    captureMethod: r.captureMethod === 'photo' || r.captureMethod === 'frame' || r.captureMethod === 'auto' ? r.captureMethod : d.captureMethod,
    shutterSound: bool('shutterSound', d.shutterSound),
    vibrate: bool('vibrate', d.vibrate),
    defaultCaptureMode: r.defaultCaptureMode === 'single' ? 'single' : 'spread',
    steps,
    enhanceBinarize: bool('enhanceBinarize', d.enhanceBinarize),
    localCleanup: bool('localCleanup', d.localCleanup),
    driveEnabled: bool('driveEnabled', d.driveEnabled),
    onboardingDone: bool('onboardingDone', d.onboardingDone),
  };
}

export function loadSettings(storage: KeyValueStorage | undefined): Settings {
  if (!storage) return defaultSettings();
  try {
    const t = storage.getItem(SETTINGS_KEY);
    return t ? sanitizeSettings(JSON.parse(t)) : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(storage: KeyValueStorage | undefined, s: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

let current: Settings = defaultSettings();
const listeners = new Set<(s: Settings) => void>();

export function initSettings(): Settings {
  current = loadSettings(browserStorage());
  return current;
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = sanitizeSettings({ ...current, ...patch });
  saveSettings(browserStorage(), current);
  for (const fn of listeners) fn(current);
  return current;
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
