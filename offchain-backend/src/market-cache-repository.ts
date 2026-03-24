import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_CACHE = { markets: [] };

function normalizeMarkets(markets: any[] = []) {
  const dedupedById = new Map();

  for (const market of Array.isArray(markets) ? markets : []) {
    if (!market || typeof market.marketId !== "string" || market.marketId === "") {
      continue;
    }

    dedupedById.set(market.marketId, market);
  }

  return [...dedupedById.values()].sort((left: any, right: any) => left.marketId.localeCompare(right.marketId));
}

export class FileMarketCacheRepository {
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
        markets: normalizeMarkets(parsed.markets)
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_CACHE };
      }

      throw error;
    }
  }

  async save(markets: any) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify({ markets: normalizeMarkets(markets) }, null, 2) + "\n",
      "utf8"
    );
  }

  async list() {
    const cache = await this.load();
    return cache.markets;
  }

  async findByMarketId(marketId: any) {
    const cache = await this.load();
    return cache.markets.find((market: any) => market.marketId === marketId) ?? null;
  }

  async upsert(market: any) {
    return this.withWriteLock(async () => {
      const cache = await this.load();
      const marketIndex = cache.markets.findIndex(
        (existingMarket: any) => existingMarket.marketId === market.marketId
      );
      const nextMarkets = [...cache.markets];

      if (marketIndex === -1) {
        nextMarkets.push(market);
      } else {
        nextMarkets[marketIndex] = market;
      }

      await this.save(nextMarkets);
      return market;
    });
  }

  async withWriteLock(work: any) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
