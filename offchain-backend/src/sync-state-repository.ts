import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { states: {} };

export class FileSyncStateRepository {
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
        states: parsed?.states && typeof parsed.states === "object" ? parsed.states : {}
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(states: any) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ states }, null, 2) + "\n", "utf8");
  }

  async getState(scope: any) {
    const store = await this.load();
    return store.states[scope] ?? null;
  }

  async setState(scope: any, value: any) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const states = {
        ...store.states,
        [scope]: value
      };
      await this.save(states);
      return value;
    });
  }

  async withWriteLock(work: any) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
