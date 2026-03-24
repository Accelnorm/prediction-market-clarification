import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { jobs: [] };

export class FileBackgroundJobRepository {
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

  async save(jobs: any) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ jobs }, null, 2) + "\n", "utf8");
  }

  async list() {
    const store = await this.load();
    return store.jobs;
  }

  async create(job: any) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const jobs = [...store.jobs, job];
      await this.save(jobs);
      return job;
    });
  }

  async findByJobId(jobId: any) {
    const store = await this.load();
    return store.jobs.find((job: any) => job.jobId === jobId) ?? null;
  }

  async listRecoverable() {
    const store = await this.load();
    return store.jobs.filter((job: any) => ["queued", "processing"].includes(job.status));
  }

  async updateByJobId(jobId: any, updates: any) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const jobIndex = store.jobs.findIndex((job: any) => job.jobId === jobId);

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

  async withWriteLock(work: any) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
