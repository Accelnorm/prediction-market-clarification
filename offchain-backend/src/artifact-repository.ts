import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { artifacts: [] };

export function createArtifactCid(artifact) {
  const digest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
  return `bafy${digest.slice(0, 32)}`;
}

export class FileArtifactRepository {
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

  async save(artifacts) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ artifacts }, null, 2) + "\n", "utf8");
  }

  async createArtifact(input) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const cid = createArtifactCid(input);
      const existingArtifact = store.artifacts.find((artifact) => artifact.cid === cid);

      if (existingArtifact) {
        return existingArtifact;
      }

      const artifact = {
        ...input,
        cid,
        url: `ipfs://${cid}`
      };
      const artifacts = [...store.artifacts, artifact];
      await this.save(artifacts);
      return artifact;
    });
  }

  async findByCid(cid) {
    const store = await this.load();
    return store.artifacts.find((artifact) => artifact.cid === cid) ?? null;
  }

  async withWriteLock(work) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
