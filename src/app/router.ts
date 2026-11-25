/**
 * 해시 라우터. GitHub Pages 는 없는 경로에 index.html 을 돌려주지 않으므로 #/... 를 쓴다.
 * 경로 해석은 순수 함수(parseRoute)라 테스트한다.
 */

export type Route =
  | { name: 'books' }
  | { name: 'book'; bookId: string }
  | { name: 'scan'; bookId: string; retake?: string }
  | { name: 'process'; bookId: string }
  | { name: 'manual'; pageId: string }
  | { name: 'compare'; bookId: string; pageId?: string }
  | { name: 'settings' }
  | { name: 'driveImport' }
  | { name: 'onboarding' };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [path = '', query = ''] = raw.split('?');
  const q = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts;
  switch (a) {
    case 'book':
      return b ? { name: 'book', bookId: b } : { name: 'books' };
    case 'scan':
      return b ? { name: 'scan', bookId: b, ...(q.get('retake') ? { retake: q.get('retake')! } : {}) } : { name: 'books' };
    case 'process':
      return b ? { name: 'process', bookId: b } : { name: 'books' };
    case 'manual':
      return b ? { name: 'manual', pageId: b } : { name: 'books' };
    case 'compare':
      return b ? { name: 'compare', bookId: b, ...(q.get('page') ? { pageId: q.get('page')! } : {}) } : { name: 'books' };
    case 'settings':
      return { name: 'settings' };
    case 'drive-import':
      return { name: 'driveImport' };
    case 'onboarding':
      return { name: 'onboarding' };
    default:
      return { name: 'books' };
  }
}

export function routeHash(r: Route): string {
  const e = encodeURIComponent;
  switch (r.name) {
    case 'books': return '#/';
    case 'book': return `#/book/${e(r.bookId)}`;
    case 'scan': return `#/scan/${e(r.bookId)}${r.retake ? `?retake=${e(r.retake)}` : ''}`;
    case 'process': return `#/process/${e(r.bookId)}`;
    case 'manual': return `#/manual/${e(r.pageId)}`;
    case 'compare': return `#/compare/${e(r.bookId)}${r.pageId ? `?page=${e(r.pageId)}` : ''}`;
    case 'settings': return '#/settings';
    case 'driveImport': return '#/drive-import';
    case 'onboarding': return '#/onboarding';
  }
}
