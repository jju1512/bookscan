/**
 * 저장 데이터 모델 (SPEC 4장). 필드 이름은 SPEC 그대로 두고, 구현에 필요한 필드만 덧붙였다.
 * 덧붙인 필드는 "(추가)" 로 표시한다.
 */

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type CaptureMode = 'spread' | 'single';

export interface Book {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  captureMode: CaptureMode;
  driveFolderId?: string;
  scanState: 'scanning' | 'finished';
  /** (추가) 다음 촬영에 줄 seq. 지운 촬영의 seq 를 다시 쓰지 않으려고 따로 센다 */
  nextSeq: number;
  /** (추가) 드라이브 하위 폴더 original/ 의 ID */
  driveOriginalFolderId?: string;
  /** (추가) book.json 을 드라이브에 다시 올려야 하는가 */
  driveMetaDirty?: boolean;
  /** (추가) 드라이브에 올린 book.json 파일 ID */
  driveMetaFileId?: string;
  /** (추가) 후처리 진행 표시. 'running' 이면 새로고침 뒤 처리 화면에서 이어서 한다 */
  processState?: 'idle' | 'running' | 'done';
  /** (추가) 다른 기기에서 불러온 책이면 원래 책 ID */
  importedFrom?: string;
}

export interface UploadInfo {
  state: StepState;
  driveFileId?: string;
  attempts: number;
  lastError?: string;
  /** (추가) 이 시각 이후에만 다시 시도한다 (백오프) */
  nextAttemptAt?: number;
  /** (추가) 업로드 도중 끊겼다. 다시 올리기 전에 드라이브에 같은 이름 파일이 있는지 본다 */
  checkRemote?: boolean;
}

export interface Capture {
  id: string;
  bookId: string;
  /** 촬영 순서 (파일 이름에 쓴다. 바뀌지 않는다) */
  seq: number;
  /** (추가) 화면·내보내기 순서. 순서 변경·재촬영은 이 값만 바꾼다 */
  order: number;
  capturedAt: number;
  /** OPFS 경로 (원본 JPEG) */
  file: string;
  width: number;
  height: number;
  bytes: number;
  /** 촬영 시 선명도 점수 (라플라시안 분산, 분석 해상도 기준) */
  sharpness: number;
  /** 썸네일 OPFS 경로 */
  thumb: string;
  upload: UploadInfo;
  deleted?: boolean;
  /** (추가) 수동 촬영이었는가 */
  manual?: boolean;
}

export type ProcessStepName = 'crop' | 'finger' | 'dewarp' | 'enhance' | 'ocr';
export const PROCESS_STEPS: readonly ProcessStepName[] = ['crop', 'finger', 'dewarp', 'enhance', 'ocr'];

export interface OcrWord {
  t: string;
  /** 좌표는 이미지 크기에 대한 비율(0~1). 단계 결과 이미지 크기가 달라도 PDF 에 바로 쓴다 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Page {
  id: string;
  bookId: string;
  captureId: string;
  side: 'left' | 'right' | 'single';
  order: number;
  steps: Record<ProcessStepName, StepState>;
  files: { crop?: string; finger?: string; dewarp?: string; enhance?: string };
  ocr?: { text: string; words: OcrWord[] };
  /** 수동 보정값. corners 는 원본 이미지 비율 좌표 [x0,y0,x1,y1,x2,y2,x3,y3] (왼위→오른위→오른아래→왼아래), splitX 도 비율 */
  manual?: { corners?: number[]; splitX?: number };
  /** (추가) 이 페이지에서 건너뛸 단계 */
  skip?: ProcessStepName[];
  /** (추가) 자동 검출 결과 (수동 보정 UI 의 시작값) */
  auto?: { corners?: number[]; splitX?: number };
  /** (추가) 단계별 메모 (실패 이유, 건너뛴 이유 등) */
  notes?: Partial<Record<ProcessStepName, string>>;
  /** (추가) 손가락이 본문 글자를 덮고 있다 → 목록에 표시해 다시 찍게 한다 */
  fingerOverText?: boolean;
  /** (추가) 자르기 실패 등으로 수동 보정이 필요하다 */
  needsManual?: boolean;
  /** (추가) 단계별 걸린 시간(ms). 남은 시간 계산에 쓴다 */
  durations?: Partial<Record<ProcessStepName, number>>;
}

/** (추가) 책 단위 드라이브 작업 (book.json, PDF) */
export interface BookJob {
  id: string;
  bookId: string;
  kind: 'bookjson' | 'pdf';
  /** OPFS 경로 (pdf) */
  file?: string;
  name: string;
  upload: UploadInfo;
  createdAt: number;
}

export function emptySteps(): Record<ProcessStepName, StepState> {
  return { crop: 'pending', finger: 'pending', dewarp: 'pending', enhance: 'pending', ocr: 'pending' };
}

/** OPFS 경로 규칙 (SPEC 4장) */
export const paths = {
  bookDir: (bookId: string) => `books/${bookId}`,
  original: (bookId: string, seq: number) => `books/${bookId}/original/${pad4(seq)}.jpg`,
  thumb: (bookId: string, seq: number) => `books/${bookId}/thumb/${pad4(seq)}.jpg`,
  pageStep: (bookId: string, pageId: string, step: string) => `books/${bookId}/pages/${pageId}/${step}.jpg`,
  pageDir: (bookId: string, pageId: string) => `books/${bookId}/pages/${pageId}`,
  exportFile: (bookId: string, name: string) => `books/${bookId}/export/${name}`,
};

export function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
