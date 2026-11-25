/**
 * 튜닝 파라미터 정의. 파라미터는 이 파일 한 곳에만 둔다 (SPEC 1장, 6장).
 *
 * 값의 단위 규칙
 * - unit: 'percent' 인 값은 비율(0~1)로 저장한다. 화면에는 ×100 해서 % 로 보여 준다.
 *   예) STILL 0.5% → 0.005
 * - 나머지는 표시 단위 그대로 저장한다.
 *
 * 기본값을 바꾸면 tests/config.test.ts 의 명세 대조표도 함께 고친다.
 */

export type ParamUnit = 'px' | 'fps' | 'ms' | 'percent' | 'level' | 'ratio';
export type ParamGroup = 'capture' | 'camera' | 'process';

export interface ParamDef {
  /** 짧은 설명 (SPEC 문구) */
  help: string;
  group: ParamGroup;
  unit: ParamUnit;
  default: number;
  min: number;
  max: number;
  /** 저장 단위 기준 증감 폭 */
  step: number;
  /** 정수만 허용 */
  integer: boolean;
}

export const PARAM_DEFS = {
  // ── 자동 촬영 (SPEC 6장 초기 파라미터) ─────────────────────────────
  ANALYSIS_WIDTH: {
    help: '분석용 축소 폭', group: 'capture', unit: 'px',
    default: 320, min: 80, max: 1280, step: 16, integer: true,
  },
  ANALYSIS_FPS: {
    help: '초당 분석 횟수', group: 'capture', unit: 'fps',
    default: 12, min: 1, max: 30, step: 1, integer: true,
  },
  PIXEL_DIFF: {
    help: '바뀐 픽셀로 볼 밝기 차이 (0~255)', group: 'capture', unit: 'level',
    default: 25, min: 1, max: 255, step: 1, integer: true,
  },
  STILL: {
    help: '이보다 적게 바뀌면 멈춘 것', group: 'capture', unit: 'percent',
    default: 0.005, min: 0, max: 1, step: 0.001, integer: false,
  },
  MOVE: {
    help: '이보다 많이 바뀌면 움직이는 것', group: 'capture', unit: 'percent',
    default: 0.05, min: 0, max: 1, step: 0.005, integer: false,
  },
  MOVE_MS: {
    help: '페이지 넘김으로 인정할 최소 움직임 시간', group: 'capture', unit: 'ms',
    default: 150, min: 0, max: 5000, step: 10, integer: true,
  },
  STABLE_MS: {
    help: '멈춤으로 인정할 시간', group: 'capture', unit: 'ms',
    default: 400, min: 0, max: 5000, step: 10, integer: true,
  },
  CHANGE_MIN: {
    help: '직전 촬영 대비 이 이상 달라야 새 페이지', group: 'capture', unit: 'percent',
    default: 0.08, min: 0, max: 1, step: 0.005, integer: false,
  },
  SHARP_RATIO: {
    help: '최근 촬영 선명도 중앙값의 이 배수 이상이어야 통과', group: 'capture', unit: 'ratio',
    default: 0.8, min: 0, max: 2, step: 0.05, integer: false,
  },
  MIN_INTERVAL_MS: {
    help: '연속 촬영 사이 최소 간격', group: 'capture', unit: 'ms',
    default: 800, min: 0, max: 10000, step: 50, integer: true,
  },

  // ── 카메라 (SPEC 6장 "카메라와 촬영": 가능한 최대 해상도 요청) ───────
  // getUserMedia 에 ideal 로 넣는 값. 기기가 지원하는 가장 가까운 해상도가 선택된다.
  // 안드로이드 후면 센서는 대개 4:3 이라 4:3 으로 요청한다.
  CAMERA_IDEAL_WIDTH: {
    help: '카메라 요청 폭 (ideal)', group: 'camera', unit: 'px',
    default: 4096, min: 320, max: 8192, step: 16, integer: true,
  },
  CAMERA_IDEAL_HEIGHT: {
    help: '카메라 요청 높이 (ideal)', group: 'camera', unit: 'px',
    default: 3072, min: 240, max: 8192, step: 16, integer: true,
  },

  // ── 후처리 (SPEC 8장 공통 규칙) ──────────────────────────────────
  PROCESS_MAX_EDGE: {
    help: '후처리할 때 이미지 긴 변 최대 길이', group: 'process', unit: 'px',
    default: 3000, min: 500, max: 8000, step: 100, integer: true,
  },
} as const satisfies Record<string, ParamDef>;

export type ParamKey = keyof typeof PARAM_DEFS;
export type Params = { readonly [K in ParamKey]: number };

export const PARAM_KEYS = Object.keys(PARAM_DEFS) as ParamKey[];

export const GROUP_LABELS: Record<ParamGroup, string> = {
  capture: '자동 촬영',
  camera: '카메라',
  process: '후처리',
};

export function paramDef(key: ParamKey): ParamDef {
  return PARAM_DEFS[key];
}

export function defaultParams(): Params {
  const out = {} as Record<ParamKey, number>;
  for (const key of PARAM_KEYS) out[key] = PARAM_DEFS[key].default;
  return out;
}

/** 저장 단위 값을 화면 표시 값으로 바꾼다. */
export function toDisplay(key: ParamKey, value: number): number {
  return PARAM_DEFS[key].unit === 'percent' ? round(value * 100) : value;
}

/** 화면 표시 값을 저장 단위 값으로 바꾼다. */
export function fromDisplay(key: ParamKey, value: number): number {
  return PARAM_DEFS[key].unit === 'percent' ? round(value / 100) : value;
}

export function unitSuffix(key: ParamKey): string {
  switch (PARAM_DEFS[key].unit) {
    case 'percent': return '%';
    case 'ratio': return '×';
    case 'level': return '';
    case 'px': return 'px';
    case 'fps': return 'fps';
    case 'ms': return 'ms';
  }
}

/** 부동소수 오차 정리 (0.1+0.2 같은 꼬리 제거) */
function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
