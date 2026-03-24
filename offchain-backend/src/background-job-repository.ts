import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackgroundJob } from "./types.js";

const EMPTY_STORE: { jobs: BackgroundJob[] } = { jobs: [] };

export class FileBackgroundJobRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ jobs: BackgroundJob[] }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(jobs: BackgroundJob[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ jobs }, null, 2) + "\n", "utf8");
  }

  async list() {
    const store = await this.load();
    return store.jobs;
  }

  async create(job: BackgroundJob) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const jobs = [...store.jobs, job];
      await this.save(jobs);
      return job;
    });
  }

  async findByJobId(jobId: string): Promise<BackgroundJob | null> {
    const store = await this.load();
    return store.jobs.find((job: BackgroundJob) => job.jobId === jobId) ?? null;
  }

  async listRecoverable() {
    const store = await this.load();
    return store.jobs.filter((job: BackgroundJob) => ["queued", "processing"].includes(job.status));
  }

  async updateByJobId(jobId: string, updates: Partial<BackgroundJob>) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const jobIndex = store.jobs.findIndex((job: BackgroundJob) => job.jobId === jobId);

      if (jobIndex === -1) {
        return null;
      }

      const nextJob = {
        ...store.jobs[jobIndex],
        ...updates
      };
      const jobs = [...store.jobs];
      jobs[jobIndex] = nextJob;
      await this.save(jobs);
      return nextJob;
    });
  }

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
