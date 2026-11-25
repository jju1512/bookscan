/**
 * 헤드리스 크롬으로 후처리 → PDF → 한글 검색을 끝까지 한 번 확인한다 (로컬 확인용).
 *
 *   npm run build && npm run preview     (다른 창)
 *   node scripts/e2e/process.mjs [--url http://localhost:4173/] [--reload-after 3]
 *
 * 1. 합성 펼침 사진 2장(tests/fixtures/synthetic)으로 ZIP 을 만들어 "ZIP 가져오기"
 * 2. 후처리 화면에서 "처리 시작" → 처리 도중 새로고침 → 이어서 처리되는지
 * 3. 끝나면 만들어진 PDF 를 OPFS 에서 꺼내 pdf.js 로 텍스트를 뽑아 한글 단어를 찾는다
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const url = args.url ?? 'http://localhost:4173/';
const chrome = args.chrome ?? process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const reloadAfter = Number(args['reload-after'] ?? 3);
const root = join(import.meta.dirname, '..', '..');
const fx = (n) => join(root, 'tests', 'fixtures', 'synthetic', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. ZIP (PNG 를 .jpg 이름으로 넣는다 — 브라우저는 내용으로 디코드한다)
const names = ['spread-flat', 'spread-finger-margin'];
const now = Date.now();
const book = {
  format: 'bookscan-book', version: 1, exportedAt: now, app: 'e2e',
  book: { id: 'e2e-book', title: 'E2E 후처리', createdAt: now, updatedAt: now, captureMode: 'spread', scanState: 'finished' },
  captures: names.map((n, i) => ({ id: `c${i}`, seq: i + 1, order: i + 1, capturedAt: now, width: 1600, height: 1150, bytes: 1, sharpness: 1, file: `original/000${i + 1}.jpg` })),
};
const entries = { 'book.json': strToU8(JSON.stringify(book)) };
names.forEach((n, i) => (entries[`original/000${i + 1}.jpg`] = new Uint8Array(readFileSync(fx(`${n}.png`)))));
const zipPath = join(tmpdir(), 'bookscan-e2e.zip');
writeFileSync(zipPath, zipSync(entries, { level: 0 }));
const expectedWords = [...new Set(names.flatMap((n) => JSON.parse(readFileSync(fx(`${n}.json`), 'utf8')).lines.join(' ').split(/\s+/)))]
  .map((w) => w.replace(/[.,]/g, ''))
  .filter((w) => /^[가-힣]{2,}$/.test(w));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 600_000 });
const out = { ok: false };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 처리 중 새로고침하면 beforeunload 경고(SPEC 4장 규칙 3)가 뜬다 → 떠나기를 수락
  let beforeUnloadSeen = 0;
  page.on('dialog', async (d) => {
    if (d.type() === 'beforeunload') beforeUnloadSeen++;
    await d.accept();
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url, { waitUntil: 'networkidle0' });

  // ZIP 가져오기
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.head-actions .btn:nth-child(2)')]);
  await chooser.accept([zipPath]);
  await page.waitForFunction(() => location.hash.startsWith('#/book/'), { timeout: 60_000 });
  const bookId = decodeURIComponent((await page.evaluate(() => location.hash)).split('/')[2]);
  out.bookId = bookId;

  // 후처리 시작
  await page.goto(`${url}#/process/${encodeURIComponent(bookId)}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.head-actions .btn-primary');
  const t0 = Date.now();
  await page.click('.head-actions .btn-primary');

  // 페이지 n쪽이 끝나면 새로고침 (중간 이어 하기 확인)
  // 진행: 후처리 화면의 단계 배지(완료·건너뜀·실패)를 센다
  const doneCount = () =>
    page.evaluate(() => {
      const all = [...document.querySelectorAll('.page-row .chips .badge')];
      const fin = all.filter((b) => /badge-(done|skipped|failed)/.test(b.className)).length;
      return { pages: document.querySelectorAll('.page-row').length, finished: fin, total: all.length, states: [...document.querySelectorAll('.page-row')].map((r) => r.querySelector('.page-info')?.innerText.split(String.fromCharCode(10)).join(' | ')) };
    });
  let st;
  for (;;) {
    await sleep(1000);
    st = await doneCount();
    console.error(`[${Math.round((Date.now() - t0) / 1000)}s] 단계 ${st.finished}/${st.total}`);
    if (st.finished >= reloadAfter || Date.now() - t0 > 300_000) break;
  }
  out.finishedBeforeReload = st.finished;
  await page.reload({ waitUntil: 'networkidle0' });
  out.beforeUnloadDialogs = beforeUnloadSeen;
  out.reloadedAt = Math.round((Date.now() - t0) / 1000);
  // 다시 열린 처리 화면이 스스로 이어서 해야 한다
  for (;;) {
    await sleep(2000);
    st = await doneCount();
    const msg = await page.evaluate(() => document.querySelector('.proc-status')?.textContent ?? '');
    console.error(`[${Math.round((Date.now() - t0) / 1000)}s] 단계 ${st.finished}/${st.total} · ${msg.slice(0, 80)} · 오류 ${errors.length}`);
    if (msg.includes('PDF 를 만들었습니다') || Date.now() - t0 > 900_000) {
      out.statusText = msg;
      break;
    }
  }
  out.seconds = Math.round((Date.now() - t0) / 1000);
  out.steps = st.states;

  // PDF 꺼내기
  const pdfB64 = await page.evaluate(async (id) => {
    let dir = await navigator.storage.getDirectory();
    for (const p of ['books', id, 'export']) dir = await dir.getDirectoryHandle(p);
    for await (const [name, h] of dir.entries()) {
      if (name.endsWith('.pdf')) {
        const buf = new Uint8Array(await (await h.getFile()).arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      }
    }
    return null;
  }, bookId);
  if (!pdfB64) throw new Error('PDF 가 없습니다');
  const pdfBytes = Buffer.from(pdfB64, 'base64');
  writeFileSync(join(tmpdir(), 'bookscan-e2e.pdf'), pdfBytes);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str ?? '').join('') + '\n';
  out.pdfPages = doc.numPages;
  out.pdfBytes = pdfBytes.length;
  const flat = text.replace(/\s+/g, '');
  const found = expectedWords.filter((w) => flat.includes(w));
  out.koreanWordsExpected = expectedWords.length;
  out.koreanWordsFound = found.length;
  out.sampleFound = found.slice(0, 10);
  out.searchExample = { word: found[0], hit: found.length > 0 };
  out.errors = errors;
  out.ok = doc.numPages === 4 && found.length / expectedWords.length > 0.5 && out.finishedBeforeReload < 20;
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
