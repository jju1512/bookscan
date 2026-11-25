/**
 * 카메라 요청 조건과 오류 설명. 브라우저 API 를 부르지 않는 순수 함수만 둔다 (단위 테스트 대상).
 */
import type { Params } from '../config';

/** 후면 카메라를 가능한 최대 해상도로 요청한다 (SPEC 6장). */
export function buildVideoConstraints(params: Pick<Params, 'CAMERA_IDEAL_WIDTH' | 'CAMERA_IDEAL_HEIGHT'>): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      // exact 가 아니라 ideal: 후면 카메라가 없는 기기(PC)에서도 열리게 한다.
      facingMode: { ideal: 'environment' },
      width: { ideal: params.CAMERA_IDEAL_WIDTH },
      height: { ideal: params.CAMERA_IDEAL_HEIGHT },
    },
  };
}

export type CameraErrorKind =
  | 'insecure'
  | 'unsupported'
  | 'denied'
  | 'not-found'
  | 'busy'
  | 'overconstrained'
  | 'unknown';

export interface CameraErrorInfo {
  kind: CameraErrorKind;
  title: string;
  detail: string;
  /** 같은 버튼으로 다시 시도해 볼 만한가 */
  retryable: boolean;
}

/** getUserMedia 가 던진 오류를 사용자에게 보여 줄 문구로 바꾼다. */
export function describeCameraError(err: unknown): CameraErrorInfo {
  const name = errorName(err);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        kind: 'denied',
        title: '카메라 권한이 막혀 있습니다',
        detail:
          '주소창 왼쪽의 사이트 설정 아이콘 → 권한 → 카메라를 "허용"으로 바꾼 뒤 다시 시도하세요. ' +
          '홈 화면에 설치한 앱이면 앱 정보 → 권한에서 바꿀 수 있습니다.',
        retryable: true,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        kind: 'not-found',
        title: '카메라를 찾지 못했습니다',
        detail: '이 기기에 사용할 수 있는 카메라가 없습니다. 촬영은 안드로이드 휴대폰에서 합니다.',
        retryable: true,
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        kind: 'busy',
        title: '카메라를 열 수 없습니다',
        detail: '다른 앱이나 탭이 카메라를 쓰고 있을 수 있습니다. 그 앱을 닫고 다시 시도하세요.',
        retryable: true,
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        kind: 'overconstrained',
        title: '요청한 카메라 설정을 지원하지 않습니다',
        detail: '디버그 패널에서 CAMERA_IDEAL_WIDTH / HEIGHT 를 낮춘 뒤 다시 시도하세요.',
        retryable: true,
      };
    default:
      return {
        kind: 'unknown',
        title: '카메라를 여는 중 오류가 났습니다',
        detail: `${name || '알 수 없는 오류'}${errorMessage(err) ? `: ${errorMessage(err)}` : ''}`,
        retryable: true,
      };
  }
}

/** 카메라 API 를 쓸 수 없는 환경인지 미리 검사한다. 쓸 수 있으면 null. */
export function checkCameraEnvironment(env: {
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
}): CameraErrorInfo | null {
  if (!env.isSecureContext) {
    return {
      kind: 'insecure',
      title: 'HTTPS 주소에서만 카메라를 쓸 수 있습니다',
      detail:
        '브라우저는 https:// 또는 localhost 에서만 카메라를 열어 줍니다. ' +
        'GitHub Pages 주소나 HTTPS 개발 서버로 다시 접속하세요.',
      retryable: false,
    };
  }
  if (!env.hasGetUserMedia) {
    return {
      kind: 'unsupported',
      title: '이 브라우저는 카메라를 지원하지 않습니다',
      detail: '안드로이드 크롬 최신 버전에서 열어 주세요.',
      retryable: false,
    };
  }
  return null;
}

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') return err.name;
  return '';
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message;
  return '';
}
