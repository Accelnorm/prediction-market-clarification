import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { catalogs: {} };

function normalizeCategories(categories: string[] = []) {
  return [...new Set(
    categories
      .filter((value: any) => typeof value === "string")
      .map((value: any) => value.trim())
      .filter(Boolean)
  )].sort((left: any, right: any) => left.localeCompare(right));
}

export class FileCategoryCatalogRepository {
  private filePath: string;
  private writeChain: Promise<void>;
  constructor(filePath: any) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        catalogs: parsed?.catalogs && typeof parsed.catalogs === "object" ? parsed.catalogs : {}
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(catalogs: any) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ catalogs }, null, 2) + "\n", "utf8");
  }

  async getCatalog(scope: any) {
    const store = await this.load();
    return store.catalogs[scope] ?? { categories: [], updatedAt: null };
  }

  async setCatalog(scope: any, { categories = [], updatedAt = null }: any) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const nextCatalog = {
        categories: normalizeCategories(categories),
        updatedAt
      };
      const catalogs = {
        ...store.catalogs,
        [scope]: nextCatalog
      };
      await this.save(catalogs);
      return nextCatalog;
    });
  }

  async withWriteLock(work: any) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
