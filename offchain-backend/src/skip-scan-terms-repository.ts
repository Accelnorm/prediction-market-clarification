import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE: { urls: string[] } = { urls: [] };

export class FileSkipScanTermsRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ urls: string[] }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return { urls: Array.isArray(parsed.urls) ? parsed.urls : [] };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return { ...EMPTY_STORE };
      throw error;
    }
  }

  async save(urls: string[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ urls }, null, 2) + "\n", "utf8");
  }

  async list(): Promise<string[]> {
    const store = await this.load();
    return store.urls;
  }

  async add(url: string): Promise<string[]> {
    return this.withWriteLock(async () => {
      const store = await this.load();
      if (!store.urls.includes(url)) {
        store.urls.push(url);
        await this.save(store.urls);
      }
      return store.urls;
    });
  }

  async remove(url: string): Promise<string[]> {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const urls = store.urls.filter((u) => u !== url);
      await this.save(urls);
      return urls;
    });
  }

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
