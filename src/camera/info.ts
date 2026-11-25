/**
 * 카메라가 실제로 준 해상도와 지원 범위를 정리한다 (디버그 패널 표시용).
 * 입력은 브라우저 객체에서 뽑은 평범한 값이라 단위 테스트할 수 있다.
 */

export interface CameraSnapshot {
  label: string;
  requested: { width: number; height: number };
  /** track.getSettings() */
  settings: { width?: number; height?: number; frameRate?: number; facingMode?: string };
  /** track.getCapabilities() — 지원하지 않는 브라우저면 undefined */
  capabilities?: { maxWidth?: number; maxHeight?: number; maxFrameRate?: number; torch?: boolean };
  /** <video>.videoWidth / videoHeight */
  video?: { width: number; height: number };
  /** ImageCapture.getPhotoCapabilities() — 사진 촬영 최대 해상도 */
  photo?: { maxWidth?: number; maxHeight?: number };
}

export interface InfoRow {
  name: string;
  value: string;
}

export function formatResolution(width?: number, height?: number): string {
  if (!width || !height) return '알 수 없음';
  const mp = (width * height) / 1_000_000;
  return `${width}×${height} (${mp.toFixed(1)}MP)`;
}

const FACING_LABEL: Record<string, string> = {
  environment: '후면',
  user: '전면',
  left: '왼쪽',
  right: '오른쪽',
};

export function facingLabel(facing?: string): string {
  if (!facing) return '알 수 없음 (PC 카메라는 보통 보고하지 않음)';
  return FACING_LABEL[facing] ?? facing;
}

/** 미리보기 위에 띄울 한 줄 요약 */
export function summaryLine(s: CameraSnapshot): string {
  const res = formatResolution(s.settings.width, s.settings.height);
  return s.settings.facingMode ? `${res} · ${facingLabel(s.settings.facingMode)}` : res;
}

export function cameraRows(s: CameraSnapshot): InfoRow[] {
  const rows: InfoRow[] = [
    { name: '장치', value: s.label || '(이름 없음)' },
    { name: '방향', value: facingLabel(s.settings.facingMode) },
    { name: '요청 (ideal)', value: `${s.requested.width}×${s.requested.height}` },
    { name: '받은 해상도', value: formatResolution(s.settings.width, s.settings.height) },
  ];
  if (s.video) rows.push({ name: '<video> 크기', value: formatResolution(s.video.width, s.video.height) });
  if (s.settings.frameRate) rows.push({ name: '프레임', value: `${round1(s.settings.frameRate)} fps` });
  if (s.capabilities) {
    rows.push({
      name: '스트림 최대',
      value: formatResolution(s.capabilities.maxWidth, s.capabilities.maxHeight),
    });
    if (s.capabilities.maxFrameRate) rows.push({ name: '최대 프레임', value: `${round1(s.capabilities.maxFrameRate)} fps` });
    rows.push({ name: '플래시(torch)', value: s.capabilities.torch ? '지원' : '지원 안 함' });
  } else {
    rows.push({ name: '스트림 최대', value: '브라우저가 알려 주지 않음' });
  }
  rows.push({
    name: '사진 최대 (takePhoto)',
    value: s.photo ? formatResolution(s.photo.maxWidth, s.photo.maxHeight) : 'ImageCapture 없음',
  });
  return rows;
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
