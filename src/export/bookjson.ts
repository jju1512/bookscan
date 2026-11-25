/**
 * book.json — ZIP 내보내기와 드라이브 백업이 함께 쓰는 책 메타데이터 형식.
 * 다른 기기에서 책을 되살릴 때 이 파일 하나로 촬영 목록과 순서를 안다.
 */
import { pad4, type Book, type Capture, type Page } from '../storage/types';

export const BOOK_JSON_FORMAT = 'bookscan-book';
export const BOOK_JSON_VERSION = 1;

export interface BookJsonCapture {
  id: string;
  seq: number;
  order: number;
  capturedAt: number;
  width: number;
  height: number;
  bytes: number;
  sharpness: number;
  manual?: boolean;
  /** ZIP·드라이브 안에서의 상대 경로. 예: original/0001.jpg */
  file: string;
  /** 드라이브에 올라간 원본 파일 ID (드라이브 백업일 때만) */
  driveFileId?: string;
}

export interface BookJson {
  format: typeof BOOK_JSON_FORMAT;
  version: number;
  exportedAt: number;
  app: string;
  book: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    captureMode: Book['captureMode'];
    scanState: Book['scanState'];
  };
  captures: BookJsonCapture[];
  /** 후처리 결과 요약 (OCR 텍스트·수동 보정값). 이미지는 넣지 않는다 */
  pages?: Array<Pick<Page, 'captureId' | 'side' | 'order' | 'manual' | 'skip'> & { text?: string }>;
}

export function originalName(seq: number): string {
  return `${pad4(seq)}.jpg`;
}

export function buildBookJson(book: Book, captures: Capture[], pages: Page[] = [], appVersion = 'dev', now = Date.now()): BookJson {
  const live = captures.filter((c) => !c.deleted).sort((a, b) => a.order - b.order);
  return {
    format: BOOK_JSON_FORMAT,
    version: BOOK_JSON_VERSION,
    exportedAt: now,
    app: `bookscan ${appVersion}`,
    book: {
      id: book.id,
      title: book.title,
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      captureMode: book.captureMode,
      scanState: book.scanState,
    },
    captures: live.map((c) => ({
      id: c.id,
      seq: c.seq,
      order: c.order,
      capturedAt: c.capturedAt,
      width: c.width,
      height: c.height,
      bytes: c.bytes,
      sharpness: c.sharpness,
      ...(c.manual ? { manual: true } : {}),
      file: `original/${originalName(c.seq)}`,
      ...(c.upload.driveFileId ? { driveFileId: c.upload.driveFileId } : {}),
    })),
    pages: pages.map((p) => ({
      captureId: p.captureId,
      side: p.side,
      order: p.order,
      ...(p.manual ? { manual: p.manual } : {}),
      ...(p.skip?.length ? { skip: p.skip } : {}),
      ...(p.ocr?.text ? { text: p.ocr.text } : {}),
    })),
  };
}

/** 검사하고 읽는다. 형식이 틀리면 사용자에게 보여 줄 문구로 오류를 던진다 */
export function parseBookJson(text: string): BookJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('book.json 을 읽을 수 없습니다 (JSON 형식 아님)');
  }
  if (!raw || typeof raw !== 'object') throw new Error('book.json 형식이 아닙니다');
  const j = raw as Partial<BookJson>;
  if (j.format !== BOOK_JSON_FORMAT) throw new Error('북스캔 book.json 이 아닙니다');
  if (typeof j.version !== 'number' || j.version > BOOK_JSON_VERSION) throw new Error(`지원하지 않는 book.json 버전입니다: ${String(j.version)}`);
  if (!j.book || typeof j.book.title !== 'string' || !Array.isArray(j.captures)) throw new Error('book.json 에 책 정보가 없습니다');
  if (j.book.captureMode !== 'spread' && j.book.captureMode !== 'single') throw new Error('book.json 의 촬영 단위가 잘못됐습니다');
  for (const c of j.captures) {
    if (typeof c?.seq !== 'number' || typeof c.file !== 'string' || !/^original\/\d{4,}\.jpg$/.test(c.file)) {
      throw new Error('book.json 의 촬영 목록이 잘못됐습니다');
    }
  }
  return j as BookJson;
}
