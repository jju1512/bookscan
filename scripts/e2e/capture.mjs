/**
 * 헤드리스 크롬으로 촬영 흐름을 끝까지 한 번 확인한다 (로컬 확인용, CI 에서는 돌리지 않는다).
 *
 *   npm run build && npm run preview        (다른 창)
 *   node tests/synthetic/gen-video.ts <tmp>/turn.y4m --pages 5 --events handOnly:2
 *   node scripts/e2e/capture.mjs --video <tmp>/turn.y4m [--url http://localhost:4173/] [--chrome <chrome.exe>]
 *
 * 하는 일: 새 책 만들기 → 촬영 시작 → 합성 페이지 넘김 영상(가짜 카메라)으로 자동 촬영 →
 * 촬영 도중 새로고침 → 촬영본이 그대로 남는지 → 책 화면의 썸네일 수 확인.
 */
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const url = args.url ?? 'http://localhost:4173/';
const chrome = args.chrome ?? process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const seconds = Number(args.seconds ?? 11);
if (!args.video) throw new Error('--video <y4m> 가 필요합니다');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${args.video}`,
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=412,915',
  ],
});
const result = { ok: false };
try {
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(new URL(url).origin, ['camera']);
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle0' });

  // 새 책
  await page.waitForSelector('.page-head .btn-primary');
  await page.click('.page-head .btn-primary');
  await page.waitForSelector('.modal input[type=text]');
  await page.type('.modal input[type=text]', 'E2E 테스트 책');
  await page.click('.modal button[type=submit]');
  await page.waitForFunction(() => location.hash.startsWith('#/book/'));
  const bookId = decodeURIComponent((await page.evaluate(() => location.hash)).split('/')[2]);
  result.bookId = bookId;

  // 촬영 시작
  await page.waitForSelector('.head-actions .btn-primary');
  await page.click('.head-actions .btn-primary');
  await page.waitForSelector('.scan-state', { timeout: 15000 });
  const t0 = Date.now();
  const states = new Set();
  let count = 0;
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(250);
    const s = await page.evaluate(() => ({ state: document.querySelector('.scan-state')?.dataset.state, counter: document.querySelector('.scan-counter')?.textContent }));
    if (s.state) states.add(s.state);
    count = Number.parseInt(s.counter ?? '0', 10);
  }
  result.statesSeen = [...states];
  result.countBeforeReload = count;
  result.resolution = await page.evaluate(() => document.querySelector('.res-badge')?.textContent);

  // 촬영 도중 새로고침 → 촬영본이 남아 있어야 한다
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.scan-counter', { timeout: 15000 });
  await sleep(500);
  result.countAfterReload = Number.parseInt(await page.evaluate(() => document.querySelector('.scan-counter')?.textContent ?? '0'), 10);
  result.dbCaptures = await page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const req = indexedDB.open('bookscan');
        req.onsuccess = () => {
          const tx = req.result.transaction('captures');
          const all = tx.objectStore('captures').index('bookId').getAll(id);
          all.onsuccess = () => resolve(all.result.filter((c) => !c.deleted).map((c) => ({ seq: c.seq, w: c.width, h: c.height, bytes: c.bytes, manual: !!c.manual })));
        };
      }),
    bookId,
  );

  // 수동 촬영(화면 탭) 한 번
  await page.click('.scan-surface');
  await page.waitForFunction((n) => Number.parseInt(document.querySelector('.scan-counter')?.textContent ?? '0', 10) > n, { timeout: 10000 }, result.countAfterReload);
  result.afterManual = Number.parseInt(await page.evaluate(() => document.querySelector('.scan-counter')?.textContent ?? '0'), 10);

  // 책 화면 썸네일
  await page.click('.camera-controls .btn:last-child');
  await page.waitForSelector('.cap-card');
  await sleep(500);
  result.cards = await page.evaluate(() => document.querySelectorAll('.cap-card').length);
  result.errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  result.ok = result.countBeforeReload >= 1 && result.countAfterReload === result.dbCaptures.length && result.cards === result.afterManual;
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
