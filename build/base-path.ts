/**
 * Vite `base` 값을 정규화한다.
 *
 * GitHub Pages 주소가 아직 정해지지 않았으므로 빌드 시 BASE_PATH 환경변수로 바꾼다.
 * - 비었거나 없으면 "/" (로컬, 사용자 사이트 `<user>.github.io`, 별도 도메인)
 * - "bookscan", "/bookscan", "/bookscan/" 모두 "/bookscan/" 으로 맞춘다 (프로젝트 사이트)
 * - actions/configure-pages 의 base_path 출력("" 또는 "/repo")을 그대로 넣어도 된다.
 */
export function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === '/' || trimmed === '.' || trimmed === './') return '/';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }
  const inner = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  return `/${inner}/`;
}
