/**
 * 후처리 단계의 공통 인터페이스 (SPEC 8장 공통 규칙). Phase 0 에서는 타입만 둔다.
 *
 * 모든 단계(crop, finger, dewarp, enhance, ocr)는 같은 모양으로 만들어서,
 * 오픈소스 구현(Phase 3)과 AI 구현(Phase 4, 보류)을 설정만으로 바꿔 끼울 수 있게 한다.
 * 이 파일은 ONNX Runtime 등 특정 구현에 의존하지 않는다.
 */

export type StepName = 'crop' | 'finger' | 'dewarp' | 'enhance' | 'ocr';

/** 같은 단계를 여러 방식으로 구현할 때 구분한다. */
export type StepImpl = 'opensource' | 'ai';

export interface StepMeta {
  bookId: string;
  pageId: string;
  /** 수동 보정값 등 앞 단계가 넘겨주는 값 */
  [key: string]: unknown;
}

export interface StepResult {
  image: ImageBitmap | Blob;
  meta: StepMeta;
}

export interface ProcessStep {
  readonly name: StepName;
  readonly impl: StepImpl;
  run(input: ImageBitmap | Blob, meta: StepMeta): Promise<StepResult>;
}
