/**
 * 책 한 권을 검색 가능한 PDF 로 만들어 OPFS 에 저장한다 (books/<id>/export/<제목>.pdf).
 * 페이지 이미지는 후처리의 마지막 결과(보정 → 펴기 → 손가락 → 자르기 순으로 있는 것), 없으면 원본 촬영.
 */
import { parseJpegSize } from '../camera/shoot';
import { finalImagePath } from '../process/runner';
import type { Repo } from '../storage/repo';
import { paths } from '../storage/types';
import { pdfFileName } from '../sync/names';
import { buildSearchablePdf, type PdfPageInput } from './pdf';

export interface BookPdfResult {
  file: Blob;
  name: string;
  path: string;
  pages: number;
  textPages: number;
  textError?: string;
}

export async function exportBookPdf(repo: Repo, bookId: string, opts: { font?: Uint8Array | null; onPage?: (d: number, t: number) => void } = {}): Promise<BookPdfResult> {
  const book = await repo.getBook(bookId);
  if (!book) throw new Error('책이 없습니다');
  const caps = new Map((await repo.listCaptures(bookId)).map((c) => [c.id, c]));
  const pages = (await repo.listPages(bookId)).filter((p) => caps.has(p.captureId));
  // 후처리하지 않은 책이면 촬영 원본을 한 장씩
  const items: { path: string; words?: PdfPageInput['words'] }[] = pages.length
    ? pages.map((p) => ({ path: finalImagePath(p) ?? caps.get(p.captureId)!.file, words: p.ocr?.words }))
    : [...caps.values()].map((c) => ({ path: c.file }));
  // 펼침 책을 후처리하지 않았으면 왼쪽·오른쪽 페이지가 같은 원본을 가리킨다 → 한 번만
  const seen = new Set<string>();
  const unique = items.filter((it) => (seen.has(it.path) ? false : (seen.add(it.path), true)));

  async function* gen(): AsyncIterable<PdfPageInput> {
    for (const it of unique) {
      const blob = await repo.files.read(it.path);
      if (!blob) continue;
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const size = parseJpegSize(jpeg.subarray(0, Math.min(jpeg.length, 256 * 1024)));
      if (!size) continue;
      yield { jpeg, width: size.width, height: size.height, words: it.words };
    }
  }

  const font = opts.font === undefined ? await loadPdfFont() : opts.font;
  const res = await buildSearchablePdf(gen, unique.length, { title: book.title, font, onPage: opts.onPage });
  const name = pdfFileName(book.title);
  const path = paths.exportFile(bookId, name);
  await repo.files.write(path, new Blob([res.bytes as BlobPart], { type: 'application/pdf' }));
  const file = (await repo.files.read(path))!;
  return { file, name, path, pages: res.pages, textPages: res.textPages, textError: res.textError };
}

/** 같은 출처의 한글 폰트 (OFL). 못 받으면 null → 이미지만 들어간 PDF */
export async function loadPdfFont(base: string = import.meta.env.BASE_URL): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${base.replace(/\/?$/, '/')}fonts/NanumGothic-Regular.ttf`);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}
