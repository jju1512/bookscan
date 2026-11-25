/**
 * OCR(Tesseract kor+eng) → 검색 가능한 PDF → 한글 텍스트 추출 (SPEC 5장 Phase 3 완료 조건 "PDF에서 한글 검색이 된다").
 * 합성 이미지 ocr-ko.png 를 쓰고, PDF 텍스트는 pdf.js 로 뽑아 확인한다.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSearchablePdf } from '../src/export/pdf';
import { normalizeWords, tessWords, type TessData } from '../src/process/ocr/ocr';
import { FIXTURES } from './helpers/cv';

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'public', 'fonts', 'NanumGothic-Regular.ttf')));
const PNG_BYTES = new Uint8Array(readFileSync(join(FIXTURES, 'ocr-ko.png')));
const truth = JSON.parse(readFileSync(join(FIXTURES, 'ocr-ko.json'), 'utf8')) as { width: number; height: number; text: string };

async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(''));
  }
  await doc.cleanup?.();
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return pages;
}

const squash = (s: string) => s.replace(/\s+/g, '');

describe('검색 가능한 PDF', () => {
  it('OCR 단어를 투명 텍스트로 넣으면 pdf.js 로 한글이 그대로 나온다 (폰트 서브셋)', async () => {
    const words = [
      { t: '손가락이', x: 0.1, y: 0.1, w: 0.2, h: 0.03 },
      { t: '페이지의', x: 0.32, y: 0.1, w: 0.2, h: 0.03 },
      { t: 'Reading', x: 0.1, y: 0.2, w: 0.15, h: 0.03 },
      { t: '책등', x: 0.1, y: 0.3, w: 0.1, h: 0.03 },
    ];
    const res = await buildSearchablePdf([{ jpeg: PNG_BYTES, width: truth.width, height: truth.height, words }], 1, { font: FONT, title: '테스트' });
    expect(res.pages).toBe(1);
    expect(res.textPages).toBe(1);
    expect(res.textError).toBeUndefined();
    // 서브셋: 2MB 폰트 전체가 아니라 쓴 글자만
    expect(res.bytes.length).toBeLessThan(PNG_BYTES.length + 200_000);
    const [text] = await pdfText(res.bytes);
    for (const w of ['손가락이', '페이지의', 'Reading', '책등']) expect(squash(text!)).toContain(w);
  });

  it('폰트가 없거나 OCR 결과가 없으면 이미지만 넣는다 (실패하면 열)', async () => {
    const res = await buildSearchablePdf([{ jpeg: PNG_BYTES, width: 100, height: 100, words: [{ t: '가', x: 0, y: 0, w: 0.5, h: 0.5 }] }], 1, { font: null });
    expect(res.pages).toBe(1);
    expect(res.textPages).toBe(0);
    const bad = await buildSearchablePdf([{ jpeg: PNG_BYTES, width: 100, height: 100 }], 1, { font: new Uint8Array([1, 2, 3]) });
    expect(bad.textError).toMatch('폰트');
    expect(bad.pages).toBe(1);
  });

  it('normalizeWords: 비율 좌표, 빈 단어·낮은 신뢰도·이미지 밖 상자 제거', () => {
    const data: TessData = {
      text: '',
      blocks: [{ paragraphs: [{ lines: [{ words: [
        { text: '가나', confidence: 90, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } },
        { text: ' ', confidence: 90, bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } },
        { text: '흐림', confidence: 3, bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } },
        { text: '밖', confidence: 90, bbox: { x0: 200, y0: 0, x1: 300, y1: 5 } },
      ] }] }] }],
    };
    expect(normalizeWords(tessWords(data), 100, 100)).toEqual([{ t: '가나', x: 0.1, y: 0.2, w: 0.5, h: 0.2 }]);
  });
});

describe('OCR (Tesseract.js kor+eng, Node)', () => {
  it('합성 한국어 페이지의 단어 대부분을 읽고, 그 결과로 만든 PDF 에서 한글을 찾을 수 있다', async () => {
    // 언어 데이터는 앱과 같은 파일(@tesseract.js-data, best_int)을 임시 폴더에 모아 쓴다
    const langDir = join(tmpdir(), 'bookscan-tessdata');
    mkdirSync(langDir, { recursive: true });
    for (const l of ['kor', 'eng']) copyFileSync(require.resolve(`@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`), join(langDir, `${l}.traineddata.gz`));
    const { createWorker, OEM } = await import('tesseract.js');
    const worker = await createWorker('kor+eng', OEM.LSTM_ONLY, { langPath: langDir, cachePath: langDir, gzip: true });
    try {
      const { data } = await worker.recognize(Buffer.from(PNG_BYTES), {}, { blocks: true, text: true });
      const words = normalizeWords(tessWords(data as unknown as TessData), truth.width, truth.height);
      const expected = truth.text.split(/\s+/).map((w) => w.replace(/[.,]/g, '')).filter((w) => w.length >= 2);
      const got = squash(data.text);
      const hit = expected.filter((w) => got.includes(w)).length;
      expect(hit / expected.length, `OCR: ${data.text}`).toBeGreaterThan(0.7);
      expect(words.length).toBeGreaterThan(20);
      for (const w of words) {
        expect(w.x).toBeGreaterThanOrEqual(0);
        expect(w.x + w.w).toBeLessThanOrEqual(1);
      }
      const res = await buildSearchablePdf([{ jpeg: PNG_BYTES, width: truth.width, height: truth.height, words }], 1, { font: FONT });
      const [text] = await pdfText(res.bytes);
      const korean = expected.filter((w) => /[가-힣]/.test(w) && got.includes(w));
      expect(korean.length).toBeGreaterThan(5);
      for (const w of korean.slice(0, 8)) expect(squash(text!)).toContain(w);
    } finally {
      await worker.terminate();
    }
  }, 180_000);
});
