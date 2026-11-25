/**
 * 후처리 단계의 공통 인터페이스 (SPEC 8장 공통 규칙).
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
  /** 결과 이미지. null 이면 입력을 바꾸지 않았다 (앞 단계 결과를 그대로 쓴다) */
  image: ImageBitmap | Blob | null;
  meta: StepMeta;
}

export interface ProcessStep {
  readonly name: StepName;
  readonly impl: StepImpl;
  run(input: ImageBitmap | Blob, meta: StepMeta): Promise<StepResult>;
}

/**
 * 단계 결과의 판정. runner 가 Page.steps 에 쓸 상태와 메모를 정한다.
 * - done: 정상
 * - skipped: 단계를 건너뜀 (예: 글자 줄이 적어 펴기 생략) → 앞 단계 결과를 쓴다
 * - failed: 실패했지만 다음 단계는 앞 결과로 계속한다 (SPEC 8장 "실패하면" 열)
 */
export interface StepOutcome {
  state: 'done' | 'skipped' | 'failed';
  note?: string;
}
