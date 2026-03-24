import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TradeActivity } from "./types.js";

const EMPTY_STORE: { activities: Record<string, TradeActivity> } = { activities: {} };

export class FileTradeActivityRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ activities: Record<string, TradeActivity> }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        activities:
          parsed?.activities && typeof parsed.activities === "object" ? parsed.activities : {}
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(activities: Record<string, TradeActivity>) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ activities }, null, 2) + "\n", "utf8");
  }

  async findByEventId(eventId: string) {
    const store = await this.load();
    return store.activities[eventId] ?? null;
  }

  async upsert(activity: TradeActivity) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const activities = {
        ...store.activities,
        [activity.eventId]: activity
      };
      await this.save(activities);
      return activity;
    });
  }

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
