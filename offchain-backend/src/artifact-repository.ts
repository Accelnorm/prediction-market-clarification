import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactInput, ArtifactRecord } from "./types.js";

const EMPTY_STORE: { artifacts: ArtifactRecord[] } = { artifacts: [] };

export function createArtifactCid(artifact: ArtifactInput): string {
  const digest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
  return `bafy${digest.slice(0, 32)}`;
}

export class FileArtifactRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ artifacts: ArtifactRecord[] }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : []
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(artifacts: ArtifactRecord[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ artifacts }, null, 2) + "\n", "utf8");
  }

  async createArtifact(input: ArtifactInput) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const cid = createArtifactCid(input);
      const existingArtifact = store.artifacts.find((artifact: ArtifactRecord) => artifact.cid === cid);

      if (existingArtifact) {
        return existingArtifact;
      }

      const artifact: ArtifactRecord = {
        ...input,
        cid,
        url: `ipfs://${cid}`
      };
      const artifacts = [...store.artifacts, artifact];
      await this.save(artifacts);
      return artifact;
    });
  }

  async findByCid(cid: string): Promise<ArtifactRecord | null> {
    const store = await this.load();
    return store.artifacts.find((artifact: ArtifactRecord) => artifact.cid === cid) ?? null;
  }

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
