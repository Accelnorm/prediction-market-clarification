import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CategoryCatalog } from "./types.js";

const EMPTY_STORE = { catalogs: {} };

function normalizeCategories(categories: string[] = []) {
  return [...new Set(
    categories
      .filter((value: string) => typeof value === "string")
      .map((value: string) => value.trim())
      .filter(Boolean)
  )].sort((left: string, right: string) => left.localeCompare(right));
}

export class FileCategoryCatalogRepository {
  private filePath: string;
  private writeChain: Promise<void>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        catalogs: parsed?.catalogs && typeof parsed.catalogs === "object" ? parsed.catalogs as Record<string, CategoryCatalog> : {} as Record<string, CategoryCatalog>
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE, catalogs: {} as Record<string, CategoryCatalog> };
      }

      throw error;
    }
  }

  async save(catalogs: Record<string, CategoryCatalog>) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ catalogs }, null, 2) + "\n", "utf8");
  }

  async getCatalog(scope: string) {
    const store = await this.load();
    return store.catalogs[scope] ?? { categories: [], updatedAt: null };
  }

  async setCatalog(scope: string, { categories = [] as string[], updatedAt = null as string | null }) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const nextCatalog: CategoryCatalog = {
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

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {}) as Promise<void>;
    return nextOperation;
  }
}
