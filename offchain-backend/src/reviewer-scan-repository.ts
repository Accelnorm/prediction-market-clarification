import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { scans: [] };

export class FileReviewerScanRepository {
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

  async save(scans: any) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ scans }, null, 2) + "\n", "utf8");
  }

  async list() {
    const store = await this.load();
    return store.scans;
  }

  async findLatestByEventId(eventId: any) {
    const scans = await this.list();

    return (
      scans
        .filter((scan: any) => scan.eventId === eventId)
        .sort((left: any, right: any) => right.createdAt.localeCompare(left.createdAt))
        .at(0) ?? null
    );
  }

  async create(scan: any) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const existingIndex =
        typeof scan.jobId === "string"
          ? store.scans.findIndex((existingScan: any) => existingScan.jobId === scan.jobId)
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

  async withWriteLock(work: any) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
