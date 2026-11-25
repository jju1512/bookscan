/**
 * 저장 공간 상태 (SPEC 4장 규칙 4·5·6). 판단 로직은 순수 함수로 두고 브라우저 호출은 얇게 감싼다.
 */

export interface StorageStatus {
  /** navigator.storage.persist() 결과. undefined 면 아직 묻지 않음 */
  persisted?: boolean;
  usage?: number;
  quota?: number;
  /** 메타데이터·파일을 오래 남길 수 없는 상태 (시크릿 모드, 저장 불가) */
  ephemeral: boolean;
  /** ephemeral 인 이유 */
  reason?: string;
}

/** 이 이하의 여유 공간이면 촬영 전에 경고한다 (원본 약 3MB × 50장) */
export const LOW_SPACE_BYTES = 150 * 1024 * 1024;
/** 크롬 시크릿 모드는 할당량이 작게 잡힌다. 이보다 작으면 시크릿 모드로 본다 */
export const INCOGNITO_QUOTA_BYTES = 200 * 1024 * 1024;

export function freeBytes(s: Pick<StorageStatus, 'usage' | 'quota'>): number | undefined {
  if (s.quota === undefined || s.usage === undefined) return undefined;
  return Math.max(0, s.quota - s.usage);
}

export function isLowSpace(s: Pick<StorageStatus, 'usage' | 'quota'>, threshold = LOW_SPACE_BYTES): boolean {
  const free = freeBytes(s);
  return free !== undefined && free < threshold;
}

export function looksEphemeral(input: { quota?: number; opfsOk: boolean; idbOk: boolean }): string | undefined {
  if (!input.idbOk) return 'IndexedDB 를 열 수 없습니다';
  if (!input.opfsOk) return '파일 저장소(OPFS)를 쓸 수 없습니다';
  if (input.quota !== undefined && input.quota < INCOGNITO_QUOTA_BYTES) return '시크릿 모드로 보입니다 (저장 공간이 매우 작음)';
  return undefined;
}

export async function estimateStorage(): Promise<{ usage?: number; quota?: number }> {
  try {
    const e = await navigator.storage?.estimate?.();
    return { usage: e?.usage, quota: e?.quota };
  } catch {
    return {};
  }
}

export async function isPersisted(): Promise<boolean | undefined> {
  try {
    return await navigator.storage?.persisted?.();
  } catch {
    return undefined;
  }
}

/** 첫 촬영 전에 부른다 (규칙 4). 이미 허용됐으면 다시 묻지 않는다 */
export async function requestPersist(): Promise<boolean | undefined> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return await navigator.storage?.persist?.();
  } catch {
    return undefined;
  }
}

export function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '알 수 없음';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}
