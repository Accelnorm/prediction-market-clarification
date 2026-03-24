// @ts-nocheck
import { FileCategoryCatalogRepository } from "../category-catalog-repository.js";
import { FileMarketCacheRepository } from "../market-cache-repository.js";
import {
  createPostgresPool,
  initializePostgresSchema,
  loadPostgresRuntimeConfig,
  PostgresCategoryCatalogRepository,
  PostgresMarketCacheRepository
} from "../postgres-storage.js";
import { PostgresSyncStateRepository } from "../postgres-storage.js";
import {
  DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL,
  DEFAULT_GEMINI_CATEGORIES_SOURCE_URL,
  DEFAULT_GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL,
  DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL,
  fetchActiveMarkets,
  fetchEnrichedPredictionMarkets,
  fetchNewlyListedMarkets,
  fetchPredictionMarketCategories,
  fetchUpcomingMarkets
} from "../gemini-markets-source.js";
import { FileSyncStateRepository } from "../sync-state-repository.js";
import {
  syncMarketCategories,
  syncMarkets,
  syncNewlyListedMarkets,
  syncUpcomingMarkets
} from "../sync-markets.js";

async function createRepositories() {
  const postgresConfig = loadPostgresRuntimeConfig();

  if (postgresConfig.connectionString) {
    const pool = createPostgresPool(postgresConfig.connectionString);
    await initializePostgresSchema(pool);
    return {
      pool,
      activeRepository: new PostgresMarketCacheRepository(pool, "active"),
      upcomingRepository: new PostgresMarketCacheRepository(pool, "upcoming"),
      categoryCatalogRepository: new PostgresCategoryCatalogRepository(pool),
      syncStateRepository: new PostgresSyncStateRepository(pool)
    };
  }

  const activeCachePath =
    process.env.MARKET_CACHE_PATH ?? new URL("../../data/market-cache.json", import.meta.url);
  const upcomingCachePath =
    process.env.UPCOMING_MARKET_CACHE_PATH ??
    new URL("../../data/upcoming-market-cache.json", import.meta.url);
  const syncStatePath =
    process.env.SYNC_STATE_PATH ?? new URL("../../data/sync-state.json", import.meta.url);
  const categoryCatalogPath =
    process.env.CATEGORY_CATALOG_PATH ?? new URL("../../data/category-catalog.json", import.meta.url);

  return {
    pool: null,
    activeRepository: new FileMarketCacheRepository(activeCachePath),
    upcomingRepository: new FileMarketCacheRepository(upcomingCachePath),
    categoryCatalogRepository: new FileCategoryCatalogRepository(categoryCatalogPath),
    syncStateRepository: new FileSyncStateRepository(syncStatePath)
  };
}

async function main() {
  const {
    pool,
    activeRepository,
    upcomingRepository,
    categoryCatalogRepository,
    syncStateRepository
  } = await createRepositories();
  const newlyListedResult = await syncNewlyListedMarkets({
    activeRepository,
    upcomingRepository,
    syncStateRepository,
    fetchMarkets: () =>
      fetchEnrichedPredictionMarkets({
        fetchMarkets: () =>
          fetchNewlyListedMarkets({
            sourceUrl:
              process.env.GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL ??
              DEFAULT_GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL
          })
      })
  });
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
  const activeCategories = await syncMarketCategories({
    repository: categoryCatalogRepository,
    scope: "active",
    fetchCategories: () =>
      fetchPredictionMarketCategories({
        sourceUrl:
          process.env.GEMINI_CATEGORIES_SOURCE_URL ?? DEFAULT_GEMINI_CATEGORIES_SOURCE_URL,
        status: ["active"]
      })
  });
  const upcomingCategories = await syncMarketCategories({
    repository: categoryCatalogRepository,
    scope: "upcoming",
    fetchCategories: () =>
      fetchPredictionMarketCategories({
        sourceUrl:
          process.env.GEMINI_CATEGORIES_SOURCE_URL ?? DEFAULT_GEMINI_CATEGORIES_SOURCE_URL,
        status: ["approved"]
      })
  });

  await pool?.end?.();

  process.stdout.write(
    `${JSON.stringify({
      newlyListed: newlyListedResult,
      active: activeResult,
      upcoming: upcomingResult,
      categories: {
        active: activeCategories,
        upcoming: upcomingCategories
      }
    })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
