import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, type Route } from '../src/app/router';
import { SETTINGS_KEY, defaultSettings, loadSettings, sanitizeSettings, saveSettings } from '../src/config/settings';

describe('해시 라우터', () => {
  it('경로를 해석하고 다시 만든다', () => {
    const cases: Route[] = [
      { name: 'books' },
      { name: 'book', bookId: 'a b' },
      { name: 'scan', bookId: 'x' },
      { name: 'scan', bookId: 'x', retake: 'c1' },
      { name: 'process', bookId: 'x' },
      { name: 'manual', pageId: 'p' },
      { name: 'compare', bookId: 'x', pageId: 'p' },
      { name: 'settings' },
      { name: 'driveImport' },
      { name: 'onboarding' },
    ];
    for (const r of cases) expect(parseRoute(routeHash(r))).toEqual(r);
  });
  it('모르는 경로와 빈 해시는 책 목록', () => {
    expect(parseRoute('')).toEqual({ name: 'books' });
    expect(parseRoute('#/nope')).toEqual({ name: 'books' });
    expect(parseRoute('#/book/')).toEqual({ name: 'books' });
  });
});

describe('사용자 설정', () => {
  it('기본값: 촬영 방식 auto, 펼침, 단계 모두 켬, 로컬 정리 꺼짐', () => {
    const d = defaultSettings();
    expect(d.captureMethod).toBe('auto');
    expect(d.defaultCaptureMode).toBe('spread');
    expect(Object.values(d.steps).every(Boolean)).toBe(true);
    expect(d.localCleanup).toBe(false);
  });
  it('잘못된 값은 기본값으로', () => {
    const s = sanitizeSettings({ captureMethod: 'x', steps: { crop: false, ocr: 'no' }, vibrate: 1 });
    expect(s.captureMethod).toBe('auto');
    expect(s.steps.crop).toBe(false);
    expect(s.steps.ocr).toBe(true);
    expect(s.vibrate).toBe(true);
  });
  it('저장·불러오기, 토큰 같은 모르는 키는 버린다', () => {
    const map = new Map<string, string>();
    const st = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    saveSettings(st, { ...defaultSettings(), captureMethod: 'frame' });
    map.set(SETTINGS_KEY, JSON.stringify({ ...JSON.parse(map.get(SETTINGS_KEY)!), accessToken: 'secret' }));
    const s = loadSettings(st);
    expect(s.captureMethod).toBe('frame');
    expect('accessToken' in s).toBe(false);
  });
});
