import { describe, expect, it } from 'vitest';
import { normalizeBase } from '../build/base-path';
import { Logger } from '../src/debug/log';

describe('BASE_PATH 정규화', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['bookscan', '/bookscan/'],
    ['/bookscan', '/bookscan/'], // actions/configure-pages 의 base_path 모양
    ['/bookscan/', '/bookscan/'],
    ['  /a/b/  ', '/a/b/'],
    ['https://example.com/app', 'https://example.com/app/'],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeBase(raw)).toBe(expected);
  });
});

describe('디버그 로그', () => {
  it('정해진 개수만 남긴다', () => {
    const log = new Logger(3, () => 0);
    for (let i = 0; i < 5; i++) log.info(`m${i}`);
    expect(log.all().map((e) => e.message)).toEqual(['m2', 'm3', 'm4']);
  });

  it('데이터를 붙여 텍스트로 내보낸다', () => {
    const log = new Logger(10, () => Date.UTC(2026, 10, 25));
    log.error('실패', new Error('boom'));
    log.info('값', { a: 1 });
    expect(log.toText()).toBe(
      '2026-11-25T00:00:00.000Z [ERROR] 실패 Error: boom\n2026-11-25T00:00:00.000Z [INFO] 값 {"a":1}',
    );
  });

  it('구독자에게 새 항목을 알린다', () => {
    const log = new Logger();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.message));
    log.warn('하나');
    off();
    log.warn('둘');
    expect(seen).toEqual(['하나']);
  });
});
