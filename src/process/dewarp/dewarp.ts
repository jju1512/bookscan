/** 펴기 (page-dewarp 이식). 구현 전 자리표시: 항상 건너뛴다 */
import type { CV, Raster } from '../raster';

export interface DewarpResult {
  raster: Raster | null;
  skipped: boolean;
  reason?: string;
  meta: Record<string, unknown>;
}

export function dewarpPage(_cv: CV, _src: Raster): DewarpResult {
  return { raster: null, skipped: true, reason: '아직 구현 전', meta: {} };
}
