/**
 * 앱 전체가 쓰는 저장소 하나를 연다. OPFS 를 못 쓰면 메모리 저장소로 떨어지고 ephemeral 로 알린다 (규칙 5).
 */
import { log } from '../debug/log';
import { openBookscanDB } from './db';
import { MemoryFileStore, OpfsFileStore, type FileStore } from './files';
import { estimateStorage, isPersisted, looksEphemeral, type StorageStatus } from './persist';
import { Repo } from './repo';

export interface OpenedStorage {
  repo: Repo;
  status: StorageStatus;
}

export async function openStorage(): Promise<OpenedStorage> {
  let files: FileStore;
  let opfsOk = true;
  try {
    const store = await OpfsFileStore.open();
    // 쓰기까지 되는지 확인한다 (일부 환경은 getDirectory 만 되고 createWritable 이 막힌다)
    await store.write('.probe', new Blob(['1']));
    await store.remove('.probe');
    files = store;
  } catch (e) {
    log.warn('OPFS 를 쓸 수 없어 메모리 저장소를 씁니다', e);
    files = new MemoryFileStore();
    opfsOk = false;
  }
  const db = await openBookscanDB();
  const est = await estimateStorage();
  const reason = looksEphemeral({ quota: est.quota, opfsOk, idbOk: true });
  const status: StorageStatus = { ...est, persisted: await isPersisted(), ephemeral: !!reason, reason };
  const repo = new Repo(db, files);
  return { repo, status };
}

export * from './types';
export { Repo } from './repo';
