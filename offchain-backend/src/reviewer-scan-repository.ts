// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { scans: [] };

export class FileReviewerScanRepository {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        scans: Array.isArray(parsed.scans) ? parsed.scans : []
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(scans) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ scans }, null, 2) + "\n", "utf8");
  }

  async list() {
    const store = await this.load();
    return store.scans;
  }

  async findLatestByEventId(eventId) {
    const scans = await this.list();

    return (
      scans
        .filter((scan) => scan.eventId === eventId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .at(0) ?? null
    );
  }

  async create(scan) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const existingIndex =
        typeof scan.jobId === "string"
          ? store.scans.findIndex((existingScan) => existingScan.jobId === scan.jobId)
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

  async withWriteLock(work) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
