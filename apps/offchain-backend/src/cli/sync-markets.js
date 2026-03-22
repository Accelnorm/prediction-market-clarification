import { readFile } from "node:fs/promises";

import { FileMarketCacheRepository } from "../market-cache-repository.js";
import { syncMarkets } from "../sync-markets.js";

async function fetchConfiguredMarkets() {
  const sourceUrl = process.env.GEMINI_MARKETS_SOURCE_URL;

  if (!sourceUrl) {
    throw new Error("GEMINI_MARKETS_SOURCE_URL is required");
  }

  if (sourceUrl.startsWith("file://")) {
    const raw = await readFile(new URL(sourceUrl), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.markets) ? parsed.markets : parsed;
  }

  const response = await fetch(sourceUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch markets: ${response.status} ${response.statusText}`);
  }

  const parsed = await response.json();
  return Array.isArray(parsed.markets) ? parsed.markets : parsed;
}

async function main() {
  const cachePath =
    process.env.MARKET_CACHE_PATH ?? new URL("../../data/market-cache.json", import.meta.url);
  const repository = new FileMarketCacheRepository(cachePath);
  const result = await syncMarkets({
    repository,
    fetchMarkets: fetchConfiguredMarkets
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
