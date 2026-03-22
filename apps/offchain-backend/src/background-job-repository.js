import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { jobs: [] };

export class FileBackgroundJobRepository {
  constructor(filePath) {
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
      if (error.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(jobs) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ jobs }, null, 2) + "\n", "utf8");
  }

  async list() {
    const store = await this.load();
    return store.jobs;
  }

  async create(job) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const jobs = [...store.jobs, job];
      await this.save(jobs);
      return job;
    });
  }

  async findByJobId(jobId) {
    const store = await this.load();
    return store.jobs.find((job) => job.jobId === jobId) ?? null;
  }

  async listRecoverable() {
    const store = await this.load();
    return store.jobs.filter((job) => ["queued", "processing"].includes(job.status));
  }

  async updateByJobId(jobId, updates) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const jobIndex = store.jobs.findIndex((job) => job.jobId === jobId);

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

  async withWriteLock(work) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
