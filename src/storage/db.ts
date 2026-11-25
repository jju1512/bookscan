/**
 * IndexedDB 스키마 (idb 래퍼). 메타데이터만 둔다. 이미지는 OPFS (files.ts).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Book, BookJob, Capture, Page } from './types';

export const DB_NAME = 'bookscan';
export const DB_VERSION = 1;

export interface BookscanDB extends DBSchema {
  books: { key: string; value: Book };
  captures: { key: string; value: Capture; indexes: { bookId: string } };
  pages: { key: string; value: Page; indexes: { bookId: string; captureId: string } };
  jobs: { key: string; value: BookJob; indexes: { bookId: string } };
  /** 작은 설정값 (드라이브 폴더 ID 등). 토큰은 넣지 않는다 (SPEC 7장) */
  kv: { key: string; value: unknown };
}

export type DB = IDBPDatabase<BookscanDB>;

/** idb 는 전역 indexedDB 를 쓴다. 테스트는 fake-indexeddb/auto 로 전역을 바꾼다. */
export function openBookscanDB(name = DB_NAME): Promise<DB> {
  return openDB<BookscanDB>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('books', { keyPath: 'id' });
        const caps = db.createObjectStore('captures', { keyPath: 'id' });
        caps.createIndex('bookId', 'bookId');
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('bookId', 'bookId');
        pages.createIndex('captureId', 'captureId');
        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('bookId', 'bookId');
        db.createObjectStore('kv');
      }
    },
    blocked() {
      // 다른 탭이 옛 버전을 열고 있다. 그 탭이 닫히면 진행된다.
    },
  });
}
