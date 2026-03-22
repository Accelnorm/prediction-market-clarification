import { FileMarketCacheRepository } from "../market-cache-repository.js";
import {
  createPostgresPool,
  initializePostgresSchema,
  loadPostgresRuntimeConfig,
  PostgresMarketCacheRepository
} from "../postgres-storage.js";
import {
  DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL,
  DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL,
  fetchActiveMarkets,
  fetchEnrichedPredictionMarkets,
  fetchUpcomingMarkets
} from "../gemini-markets-source.js";
import { syncMarkets, syncUpcomingMarkets } from "../sync-markets.js";

async function createRepositories() {
  const postgresConfig = loadPostgresRuntimeConfig();

  if (postgresConfig.connectionString) {
    const pool = createPostgresPool(postgresConfig.connectionString);
    await initializePostgresSchema(pool);
    return {
      pool,
      activeRepository: new PostgresMarketCacheRepository(pool, "active"),
      upcomingRepository: new PostgresMarketCacheRepository(pool, "upcoming")
    };
  }

  const activeCachePath =
    process.env.MARKET_CACHE_PATH ?? new URL("../../data/market-cache.json", import.meta.url);
  const upcomingCachePath =
    process.env.UPCOMING_MARKET_CACHE_PATH ??
    new URL("../../data/upcoming-market-cache.json", import.meta.url);

  return {
    pool: null,
    activeRepository: new FileMarketCacheRepository(activeCachePath),
    upcomingRepository: new FileMarketCacheRepository(upcomingCachePath)
  };
}

async function main() {
  const { pool, activeRepository, upcomingRepository } = await createRepositories();
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

  await pool?.end?.();

  process.stdout.write(
    `${JSON.stringify({ active: activeResult, upcoming: upcomingResult })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
