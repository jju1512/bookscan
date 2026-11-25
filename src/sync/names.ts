/**
 * 드라이브 폴더·파일 이름 규칙 (SPEC 7장 "드라이브 폴더 구조").
 *
 *   BookScan/<책 제목>_<YYYYMMDD>/original/0001.jpg, book.json, <책 제목>.pdf
 */

export const ROOT_FOLDER_NAME = 'BookScan';
export const ORIGINAL_FOLDER_NAME = 'original';
export const BOOK_JSON_NAME = 'book.json';
/** 이 크기 이하는 multipart, 넘으면 resumable 업로드 */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;

const MAX_NAME_CHARS = 80;
const EMPTY_TITLE = '제목 없음';

/** 파일 이름에 못 쓰는 글자(`/\:*?"<>|`)와 제어문자를 `_` 로 바꾸고 앞뒤 공백을 없앤다. 최대 80자 */
export function sanitizeTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const replaced = title.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  // 글자 단위(코드 포인트)로 자른다. 이모지 같은 글자를 반으로 자르지 않는다
  const cut = Array.from(replaced).slice(0, MAX_NAME_CHARS).join('').trim();
  return cut || EMPTY_TITLE;
}

/** 로컬 시간대 기준 YYYYMMDD */
export function dateStamp(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${mm}${dd}`;
}

/** 책 폴더 이름: `<정리한 제목>_<YYYYMMDD>` */
export function bookFolderName(title: string, createdAt: number): string {
  return `${sanitizeTitle(title)}_${dateStamp(createdAt)}`;
}

/** 후처리 PDF 파일 이름: `<정리한 제목>.pdf` */
export function pdfFileName(title: string): string {
  return `${sanitizeTitle(title)}.pdf`;
}
