import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewerScan } from "./types.js";

const EMPTY_STORE: { scans: ReviewerScan[] } = { scans: [] };

export class FileReviewerScanRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ scans: ReviewerScan[] }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        scans: Array.isArray(parsed.scans) ? parsed.scans : []
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(scans: ReviewerScan[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ scans }, null, 2) + "\n", "utf8");
  }

  async list(): Promise<ReviewerScan[]> {
    const store = await this.load();
    return store.scans;
  }

  async findLatestByEventId(eventId: string) {
    const scans = await this.list();

    return (
      scans
        .filter((scan: ReviewerScan) => scan.eventId === eventId)
        .sort((left: ReviewerScan, right: ReviewerScan) =>
          right.createdAt.localeCompare(left.createdAt)
        )
        .at(0) ?? null
    );
  }

  async create(scan: ReviewerScan) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const existingIndex =
        typeof scan.jobId === "string"
          ? store.scans.findIndex((existingScan: ReviewerScan) => existingScan.jobId === scan.jobId)
          : -1;

      if (existingIndex !== -1) {
        const scans = [...store.scans];
        scans[existingIndex] = {
          ...scans[existingIndex],
          ...scan
        };
        await this.save(scans);
        return scans[existingIndex];
      }

      const scans = [...store.scans, scan];
      await this.save(scans);
      return scan;
    });
  }

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
