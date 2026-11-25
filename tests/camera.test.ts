import { describe, expect, it } from 'vitest';
import { buildVideoConstraints, checkCameraEnvironment, describeCameraError } from '../src/camera/constraints';
import { cameraRows, formatResolution, summaryLine, type CameraSnapshot } from '../src/camera/info';
import { defaultParams } from '../src/config/params';

describe('카메라 요청 조건', () => {
  it('후면 카메라를 ideal 로, 설정한 최대 해상도로 요청한다', () => {
    const c = buildVideoConstraints(defaultParams());
    expect(c.audio).toBe(false);
    expect(c.video).toEqual({
      facingMode: { ideal: 'environment' },
      width: { ideal: 4096 },
      height: { ideal: 3072 },
    });
  });
});

describe('카메라 오류 설명', () => {
  const named = (name: string, message = '') => Object.assign(new Error(message), { name });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'busy'],
    ['OverconstrainedError', 'overconstrained'],
    ['WeirdError', 'unknown'],
  ])('%s → %s', (name, kind) => {
    expect(describeCameraError(named(name)).kind).toBe(kind);
  });

  it('모르는 오류는 이름과 메시지를 보여 준다', () => {
    expect(describeCameraError(named('WeirdError', 'boom')).detail).toBe('WeirdError: boom');
    expect(describeCameraError('문자열').detail).toBe('알 수 없는 오류');
  });

  it('HTTPS 가 아니면 다시 시도할 수 없는 오류', () => {
    const p = checkCameraEnvironment({ isSecureContext: false, hasGetUserMedia: false });
    expect(p?.kind).toBe('insecure');
    expect(p?.retryable).toBe(false);
  });

  it('getUserMedia 가 없으면 unsupported', () => {
    expect(checkCameraEnvironment({ isSecureContext: true, hasGetUserMedia: false })?.kind).toBe('unsupported');
  });

  it('문제가 없으면 null', () => {
    expect(checkCameraEnvironment({ isSecureContext: true, hasGetUserMedia: true })).toBeNull();
  });
});

describe('카메라 정보 표시', () => {
  const snap: CameraSnapshot = {
    label: 'camera2 0, facing back',
    requested: { width: 4096, height: 3072 },
    settings: { width: 4000, height: 3000, frameRate: 29.97, facingMode: 'environment' },
    capabilities: { maxWidth: 4000, maxHeight: 3000, maxFrameRate: 30, torch: true },
    video: { width: 4000, height: 3000 },
    photo: { maxWidth: 4032, maxHeight: 3024 },
  };

  it('해상도를 메가픽셀과 함께 쓴다', () => {
    expect(formatResolution(4000, 3000)).toBe('4000×3000 (12.0MP)');
    expect(formatResolution(undefined, 3000)).toBe('알 수 없음');
  });

  it('미리보기 배지에 받은 해상도와 방향을 보인다', () => {
    expect(summaryLine(snap)).toBe('4000×3000 (12.0MP) · 후면');
    expect(summaryLine({ ...snap, settings: { width: 1280, height: 720 } })).toBe('1280×720 (0.9MP)');
  });

  it('디버그 패널 표에 요청·받은·최대 해상도를 모두 넣는다', () => {
    const rows = Object.fromEntries(cameraRows(snap).map((r) => [r.name, r.value]));
    expect(rows['요청 (ideal)']).toBe('4096×3072');
    expect(rows['받은 해상도']).toBe('4000×3000 (12.0MP)');
    expect(rows['스트림 최대']).toBe('4000×3000 (12.0MP)');
    expect(rows['사진 최대 (takePhoto)']).toBe('4032×3024 (12.2MP)');
    expect(rows['플래시(torch)']).toBe('지원');
    expect(rows['프레임']).toBe('30 fps');
  });

  it('지원 정보가 없으면 그렇다고 쓴다', () => {
    const rows = Object.fromEntries(
      cameraRows({ label: '', requested: { width: 4096, height: 3072 }, settings: {} }).map((r) => [r.name, r.value]),
    );
    expect(rows['스트림 최대']).toBe('브라우저가 알려 주지 않음');
    expect(rows['사진 최대 (takePhoto)']).toBe('ImageCapture 없음');
  });
});
