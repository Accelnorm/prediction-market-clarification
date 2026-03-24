import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { activities: {} };

export class FileTradeActivityRepository {
  private filePath: string;
  private writeChain: Promise<void>;
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load() {
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

  async save(activities) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ activities }, null, 2) + "\n", "utf8");
  }

  async findByEventId(eventId) {
    const store = await this.load();
    return store.activities[eventId] ?? null;
  }

  async upsert(activity) {
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

  async withWriteLock(work) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
