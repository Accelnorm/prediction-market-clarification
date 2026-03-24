import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MarketRecord } from "./types.js";

const EMPTY_CACHE: { markets: MarketRecord[] } = { markets: [] };

function normalizeMarkets(markets: MarketRecord[] = []): MarketRecord[] {
  const dedupedById = new Map<string, MarketRecord>();

  for (const market of Array.isArray(markets) ? markets : []) {
    if (!market || typeof market.marketId !== "string" || market.marketId === "") {
      continue;
    }

    dedupedById.set(market.marketId, market);
  }

  return [...dedupedById.values()].sort((left, right) => left.marketId.localeCompare(right.marketId));
}

export class FileMarketCacheRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ markets: MarketRecord[] }> {
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

  async save(markets: MarketRecord[]) {
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

  async findByMarketId(marketId: string) {
    const cache = await this.load();
    return cache.markets.find((market) => market.marketId === marketId) ?? null;
  }

  async upsert(market: MarketRecord) {
    return this.withWriteLock(async () => {
      const cache = await this.load();
      const marketIndex = cache.markets.findIndex((existingMarket) => existingMarket.marketId === market.marketId);
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

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
