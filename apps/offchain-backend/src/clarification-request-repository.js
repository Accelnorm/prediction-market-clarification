import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { requests: [] };

export class FileClarificationRequestRepository {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        requests: Array.isArray(parsed.requests) ? parsed.requests : []
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(requests) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ requests }, null, 2) + "\n", "utf8");
  }

  async create(request) {
    const store = await this.load();
    const requests = [...store.requests, request];
    await this.save(requests);
    return request;
  }
}
