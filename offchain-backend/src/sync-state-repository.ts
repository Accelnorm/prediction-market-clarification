import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SyncStateMap } from "./types.js";

const EMPTY_STORE: { states: SyncStateMap } = { states: {} };

export class FileSyncStateRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ states: SyncStateMap }> {
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

  async save(states: SyncStateMap) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ states }, null, 2) + "\n", "utf8");
  }

  async getState(scope: string) {
    const store = await this.load();
    return store.states[scope] ?? null;
  }

  async setState(scope: string, value: unknown) {
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

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
