import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_CACHE = { markets: [] };

export class FileMarketCacheRepository {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        markets: Array.isArray(parsed.markets) ? parsed.markets : []
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ...EMPTY_CACHE };
      }

      throw error;
    }
  }

  async save(markets) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ markets }, null, 2) + "\n", "utf8");
  }

  async list() {
    const cache = await this.load();
    return cache.markets;
  }

  async findByMarketId(marketId) {
    const cache = await this.load();
    return cache.markets.find((market) => market.marketId === marketId) ?? null;
  }

  async upsert(market) {
    const cache = await this.load();
    const marketIndex = cache.markets.findIndex(
      (existingMarket) => existingMarket.marketId === market.marketId
    );
    const nextMarkets = [...cache.markets];

    if (marketIndex === -1) {
      nextMarkets.push(market);
    } else {
      nextMarkets[marketIndex] = market;
    }

    nextMarkets.sort((left, right) => left.marketId.localeCompare(right.marketId));
    await this.save(nextMarkets);
    return market;
  }
}
