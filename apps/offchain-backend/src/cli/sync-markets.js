import { FileMarketCacheRepository } from "../market-cache-repository.js";
import {
  DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL,
  DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL,
  fetchActiveMarkets,
  fetchEnrichedPredictionMarkets,
  fetchUpcomingMarkets
} from "../gemini-markets-source.js";
import { syncMarkets, syncUpcomingMarkets } from "../sync-markets.js";

async function main() {
  const activeCachePath =
    process.env.MARKET_CACHE_PATH ?? new URL("../../data/market-cache.json", import.meta.url);
  const upcomingCachePath =
    process.env.UPCOMING_MARKET_CACHE_PATH ??
    new URL("../../data/upcoming-market-cache.json", import.meta.url);
  const activeRepository = new FileMarketCacheRepository(activeCachePath);
  const upcomingRepository = new FileMarketCacheRepository(upcomingCachePath);
  const activeResult = await syncMarkets({
    repository: activeRepository,
    fetchMarkets: () =>
      fetchEnrichedPredictionMarkets({
        fetchMarkets: () =>
          fetchActiveMarkets({
            sourceUrl:
              process.env.GEMINI_MARKETS_SOURCE_URL ??
              DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL
          })
      })
  });
  const upcomingResult = await syncUpcomingMarkets({
    repository: upcomingRepository,
    fetchMarkets: () =>
      fetchEnrichedPredictionMarkets({
        fetchMarkets: () =>
          fetchUpcomingMarkets({
            sourceUrl:
              process.env.GEMINI_UPCOMING_MARKETS_SOURCE_URL ??
              DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL
          })
      })
  });

  process.stdout.write(
    `${JSON.stringify({ active: activeResult, upcoming: upcomingResult })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
