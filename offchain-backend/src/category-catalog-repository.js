import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { catalogs: {} };

function normalizeCategories(categories = []) {
  return [...new Set(
    categories
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
}

export class FileCategoryCatalogRepository {
  constructor(filePath) {
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
      if (error.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(catalogs) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ catalogs }, null, 2) + "\n", "utf8");
  }

  async getCatalog(scope) {
    const store = await this.load();
    return store.catalogs[scope] ?? { categories: [], updatedAt: null };
  }

  async setCatalog(scope, { categories = [], updatedAt = null }) {
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

  async withWriteLock(work) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
