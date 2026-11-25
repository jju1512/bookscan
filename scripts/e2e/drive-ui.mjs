/**
 * 드라이브 화면 확인 (로컬). 실제 구글 로그인은 하지 않는다.
 *   --expect none   : VITE_GOOGLE_CLIENT_ID 없이 빌드 → 온보딩 없이 목록, 설정에 "설정 필요", 불러오기 버튼 없음
 *   --expect id     : 아무 ID 로 빌드 → 첫 접속에 온보딩 질문 → "나중에" → 목록, 설정에 "연동하기"
 *   node scripts/e2e/drive-ui.mjs --expect none [--url http://localhost:4173/]
 */
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const url = args.url ?? 'http://localhost:4173/';
const chrome = args.chrome ?? process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const out = { expect: args.expect };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  out.firstHash = await page.evaluate(() => location.hash);
  out.firstText = await page.evaluate(() => document.querySelector('#screen')?.textContent?.slice(0, 80));
  if (args.expect === 'id') {
    out.onboarding = out.firstText.includes('구글 드라이브에 백업할까요?');
    const later = await page.$$('xpath/.//button[contains(., "나중에")]');
    await later[0].click();
    await new Promise((r) => setTimeout(r, 500));
    out.afterLater = await page.evaluate(() => location.hash);
  }
  out.importButton = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('드라이브에서 불러오기')));
  await page.goto(url + '#/settings', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 500));
  const settings = await page.evaluate(() => document.querySelector('#screen')?.textContent ?? '');
  out.settingsNeedsSetup = settings.includes('설정 필요');
  out.settingsLink = settings.includes('연동하기');
  out.errors = errors;
  out.ok =
    args.expect === 'none'
      ? !out.firstText.includes('백업할까요') && out.settingsNeedsSetup && !out.importButton && errors.length === 0
      : out.onboarding && out.afterLater === '#/' && out.settingsLink && out.importButton && errors.length === 0;
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
