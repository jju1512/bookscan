/**
 * 검색 가능한 PDF (SPEC 8장): pdf-lib 로 페이지 이미지 + 투명 텍스트 레이어.
 * - 한글 폰트(NanumGothic, OFL)는 fontkit 으로 쓰인 글자만 서브셋해 넣는다.
 * - 글자는 렌더 모드 3(보이지 않음)으로 OCR 단어 상자 위치에 놓고, 가로 배율(Tz)로 상자 폭에 맞춘다.
 *   그래서 PDF 뷰어에서 검색·선택은 되지만 화면에는 이미지만 보인다.
 * - OCR 결과가 없는 페이지는 이미지만 넣는다. 폰트를 못 읽으면 전체를 이미지만으로 만든다 (실패하면 열).
 */
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  TextRenderingMode,
  beginText,
  endText,
  moveText,
  setFontAndSize,
  setTextRenderingMode,
  showText,
  type PDFFont,
} from 'pdf-lib';
import type { OcrWord } from '../storage/types';

export interface PdfPageInput {
  jpeg: Uint8Array;
  /** 이미지 픽셀 크기 */
  width: number;
  height: number;
  words?: OcrWord[];
}

export interface PdfOptions {
  title?: string;
  /** 이미지 픽셀을 포인트로 바꿀 때 쓰는 해상도 (기본 200dpi) */
  dpi?: number;
  /** 한글 폰트 TTF/OTF. 없으면 텍스트 레이어 없이 만든다 */
  font?: Uint8Array | null;
  onPage?: (done: number, total: number) => void;
}

export interface PdfBuildResult {
  bytes: Uint8Array;
  pages: number;
  textPages: number;
  /** 텍스트 레이어를 넣지 못한 이유 (폰트 문제 등) */
  textError?: string;
}

export async function buildSearchablePdf(pages: PdfPageInput[] | (() => AsyncIterable<PdfPageInput>), total: number, opts: PdfOptions = {}): Promise<PdfBuildResult> {
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title ?? '북스캔');
  doc.setCreator('북스캔 (bookscan)');
  doc.setProducer('pdf-lib');
  const dpi = opts.dpi ?? 200;
  let font: PDFFont | null = null;
  let textError: string | undefined;
  if (opts.font) {
    try {
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(opts.font, { subset: true });
    } catch (e) {
      textError = `폰트를 넣지 못해 이미지만 넣습니다: ${e instanceof Error ? e.message : String(e)}`;
      font = null;
    }
  }
  let done = 0;
  let textPages = 0;
  const iter = typeof pages === 'function' ? pages() : toAsync(pages);
  for await (const p of iter) {
    // PNG 서명이면 PNG 로 (테스트·흑백 보정 결과), 아니면 JPEG
    const img = p.jpeg[0] === 0x89 && p.jpeg[1] === 0x50 ? await doc.embedPng(p.jpeg) : await doc.embedJpg(p.jpeg);
    const pw = (p.width * 72) / dpi;
    const ph = (p.height * 72) / dpi;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    if (font && p.words?.length) {
      try {
        addTextLayer(page, font, p.words, pw, ph);
        textPages++;
      } catch (e) {
        textError ??= `텍스트 레이어 오류: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    done++;
    opts.onPage?.(done, total); // ?.() 는 인자도 평가하지 않으므로 ++ 를 안에 두지 않는다
  }
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pages: done, textPages, textError };
}

async function* toAsync<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

type PdfPage = ReturnType<PDFDocument['addPage']>;

function addTextLayer(page: PdfPage, font: PDFFont, words: OcrWord[], pw: number, ph: number): void {
  const key = page.node.newFontDictionary(font.name, font.ref);
  const ops: PDFOperator[] = [];
  for (const w of words) {
    const boxW = w.w * pw;
    const boxH = w.h * ph;
    if (boxW <= 0 || boxH <= 0) continue;
    const size = Math.max(1, boxH * 0.9);
    const natural = font.widthOfTextAtSize(w.t, size);
    const scale = natural > 0 ? Math.max(10, Math.min(500, (boxW / natural) * 100)) : 100;
    // 기준선은 상자 아래에서 높이의 약 15% 위
    const x = w.x * pw;
    const y = ph - (w.y + w.h) * ph + boxH * 0.15;
    ops.push(
      beginText(),
      setFontAndSize(key, size),
      setTextRenderingMode(TextRenderingMode.Invisible),
      PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(scale)]),
      moveText(x, y),
      showText(font.encodeText(`${w.t} `)),
      endText(),
    );
  }
  page.pushOperators(...ops);
}
