/**
 * 이미지 파일 저장소. 브라우저에서는 OPFS(Origin Private File System), 테스트·저장 불가 상태에서는 메모리.
 * 경로는 'books/<bookId>/original/0001.jpg' 처럼 '/' 로 나눈다.
 */

export interface FileStore {
  readonly kind: 'opfs' | 'memory';
  write(path: string, data: Blob): Promise<void>;
  /** 없으면 null */
  read(path: string): Promise<Blob | null>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** 폴더 통째로 지운다 (없으면 조용히 넘어간다) */
  removeDir(path: string): Promise<void>;
  /** 큰 파일을 조각으로 쓴다 (ZIP 내보내기). close 해야 파일이 생긴다 */
  openWriter(path: string): Promise<FileWriter>;
}

export interface FileWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

function split(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.')) throw new Error(`잘못된 경로: ${path}`);
  return parts;
}

/** 메모리 저장소. 시크릿 모드 등 OPFS 를 쓸 수 없을 때와 테스트에 쓴다. 탭을 닫으면 사라진다. */
export class MemoryFileStore implements FileStore {
  readonly kind = 'memory' as const;
  readonly files = new Map<string, Blob>();

  async write(path: string, data: Blob): Promise<void> {
    this.files.set(split(path).join('/'), data);
  }
  async read(path: string): Promise<Blob | null> {
    return this.files.get(split(path).join('/')) ?? null;
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(split(path).join('/'));
  }
  async remove(path: string): Promise<void> {
    this.files.delete(split(path).join('/'));
  }
  async removeDir(path: string): Promise<void> {
    const prefix = split(path).join('/') + '/';
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }
  async openWriter(path: string): Promise<FileWriter> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (c) => void chunks.push(c.slice()),
      close: async () => this.write(path, new Blob(chunks as BlobPart[])),
      abort: async () => void (chunks.length = 0),
    };
  }
}

/** OPFS 저장소 */
export class OpfsFileStore implements FileStore {
  readonly kind = 'opfs' as const;
  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsFileStore> {
    const root = await navigator.storage.getDirectory();
    return new OpfsFileStore(root);
  }

  private async dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let d = this.root;
    for (const p of parts) {
      try {
        d = await d.getDirectoryHandle(p, { create });
      } catch (e) {
        if (!create && isNotFound(e)) return null;
        throw e;
      }
    }
    return d;
  }

  private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const parts = split(path);
    const name = parts.pop()!;
    const d = await this.dir(parts, create);
    if (!d) return null;
    try {
      return await d.getFileHandle(name, { create });
    } catch (e) {
      if (!create && isNotFound(e)) return null;
      throw e;
    }
  }

  async write(path: string, data: Blob): Promise<void> {
    const fh = await this.fileHandle(path, true);
    const w = await fh!.createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
  }

  async read(path: string): Promise<Blob | null> {
    const fh = await this.fileHandle(path, false);
    return fh ? fh.getFile() : null;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.fileHandle(path, false)) !== null;
  }

  async remove(path: string): Promise<void> {
    const parts = split(path);
    const name = parts.pop()!;
    const d = await this.dir(parts, false);
    if (!d) return;
    try {
      await d.removeEntry(name);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async removeDir(path: string): Promise<void> {
    const parts = split(path);
    const name = parts.pop()!;
    const d = await this.dir(parts, false);
    if (!d) return;
    try {
      await d.removeEntry(name, { recursive: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async openWriter(path: string): Promise<FileWriter> {
    const fh = await this.fileHandle(path, true);
    const w = await fh!.createWritable();
    return {
      write: (c) => w.write(c as unknown as BufferSource),
      close: () => w.close(),
      abort: () => w.abort(),
    };
  }
}

function isNotFound(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'NotFoundError' || e.name === 'TypeMismatchError' : false;
}
