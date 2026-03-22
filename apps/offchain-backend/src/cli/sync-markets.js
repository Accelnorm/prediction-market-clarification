import { FileMarketCacheRepository } from "../market-cache-repository.js";
import {
  DEFAULT_GEMINI_MARKETS_SOURCE_URL,
  fetchConfiguredMarkets
} from "../gemini-markets-source.js";
import { syncMarkets } from "../sync-markets.js";

async function main() {
  const cachePath =
    process.env.MARKET_CACHE_PATH ?? new URL("../../data/market-cache.json", import.meta.url);
  const repository = new FileMarketCacheRepository(cachePath);
  const result = await syncMarkets({
    repository,
    fetchMarkets: () =>
      fetchConfiguredMarkets({
        sourceUrl: process.env.GEMINI_MARKETS_SOURCE_URL ?? DEFAULT_GEMINI_MARKETS_SOURCE_URL
      })
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
