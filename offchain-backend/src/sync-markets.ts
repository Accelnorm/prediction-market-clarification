// @ts-nocheck
import {
  normalizeGeminiMarket,
  sameNormalizedMarketShape
} from "./gemini-market-normalizer.js";

function isMarketWithStatus(market, status) {
  if (typeof market?.status === "string") {
    return market.status.toLowerCase() === status;
  }

  return false;
}

function uniqueMarkets(markets = []) {
  const dedupedById = new Map();

  for (const market of Array.isArray(markets) ? markets : []) {
    if (!market || typeof market.id === "undefined" || market.id === null) {
      continue;
    }

    dedupedById.set(String(market.id), market);
  }

  return [...dedupedById.values()];
}

function shouldKeepNewlyListedEvent({ sourceMarket, syncState }) {
  const createdAt = typeof sourceMarket?.createdAt === "string" ? sourceMarket.createdAt : null;

  if (!createdAt || !syncState?.lastCreatedAt) {
    return true;
  }

  if (createdAt > syncState.lastCreatedAt) {
    return true;
  }

  if (createdAt < syncState.lastCreatedAt) {
    return false;
  }

  return !Array.isArray(syncState.boundaryEventIds) || !syncState.boundaryEventIds.includes(String(sourceMarket.id));
}

function buildNextSyncState({ sourceMarkets, syncedAt }) {
  if (!Array.isArray(sourceMarkets) || sourceMarkets.length === 0) {
    return {
      lastCreatedAt: null,
      boundaryEventIds: [],
      lastSyncedAt: syncedAt,
      updatedAt: syncedAt
    };
  }

  const latestCreatedAt = sourceMarkets
    .map((market) => (typeof market?.createdAt === "string" ? market.createdAt : null))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const boundaryEventIds = latestCreatedAt
    ? sourceMarkets
        .filter((market) => market?.createdAt === latestCreatedAt)
        .map((market) => String(market.id))
        .sort((left, right) => left.localeCompare(right))
    : [];

  return {
    lastCreatedAt: latestCreatedAt,
    boundaryEventIds,
    lastSyncedAt: syncedAt,
    updatedAt: syncedAt
  };
}

async function syncMarketSet({
  repository,
  fetchMarkets,
  now = () => new Date(),
  includeMarket = () => true,
  totalKey
}) {
  const sourceMarkets = uniqueMarkets(await fetchMarkets());
  const matchingMarkets = sourceMarkets.filter(includeMarket);
  const cache = await repository.load();
  const marketsById = new Map(cache.markets.map((market) => [market.marketId, market]));
  const lastSyncedAt = now().toISOString();

  let inserted = 0;
  let updated = 0;

  for (const sourceMarket of matchingMarkets) {
    const normalized = normalizeGeminiMarket(sourceMarket, lastSyncedAt);
    const existing = marketsById.get(normalized.marketId);

    if (!existing) {
      inserted += 1;
      marketsById.set(normalized.marketId, normalized);
      continue;
    }

    updated += 1;
    marketsById.set(
      normalized.marketId,
      sameNormalizedMarketShape(existing, normalized)
        ? { ...existing, lastSyncedAt }
        : normalized
    );
  }

  const markets = [...marketsById.values()].sort((left, right) =>
    left.marketId.localeCompare(right.marketId)
  );

  await repository.save(markets);

  return {
    inserted,
    updated,
    [totalKey]: matchingMarkets.length
  };
}

export async function syncMarkets({ repository, fetchMarkets, now = () => new Date() }) {
  return syncMarketSet({
    repository,
    fetchMarkets,
    now,
    includeMarket: (market) => isMarketWithStatus(market, "active"),
    totalKey: "totalActive"
  });
}

export async function syncUpcomingMarkets({ repository, fetchMarkets, now = () => new Date() }) {
  return syncMarketSet({
    repository,
    fetchMarkets,
    now,
    includeMarket: (market) => isMarketWithStatus(market, "approved"),
    totalKey: "totalUpcoming"
  });
}

export async function syncMarketCategories({
  repository,
  fetchCategories,
  scope,
  now = () => new Date()
}) {
  const categories = await fetchCategories();
  return repository.setCatalog(scope, {
    categories,
    updatedAt: now().toISOString()
  });
}

export async function syncNewlyListedMarkets({
  activeRepository,
  upcomingRepository,
  fetchMarkets,
  syncStateRepository,
  syncStateScope = "markets:newly-listed",
  now = () => new Date()
}) {
  const sourceMarkets = uniqueMarkets(await fetchMarkets());
  const syncState = await syncStateRepository.getState(syncStateScope);
  const candidates = sourceMarkets.filter((market) =>
    shouldKeepNewlyListedEvent({
      sourceMarket: market,
      syncState
    })
  );
  const syncTimestamp = now().toISOString();
  const activeCache = await activeRepository.load();
  const upcomingCache = await upcomingRepository.load();
  const activeById = new Map(activeCache.markets.map((market) => [market.marketId, market]));
  const upcomingById = new Map(upcomingCache.markets.map((market) => [market.marketId, market]));

  let insertedActive = 0;
  let updatedActive = 0;
  let insertedUpcoming = 0;
  let updatedUpcoming = 0;

  for (const sourceMarket of candidates) {
    const normalized = normalizeGeminiMarket(sourceMarket, syncTimestamp);

    if (isMarketWithStatus(sourceMarket, "active")) {
      const existing = activeById.get(normalized.marketId);
      if (existing) {
        updatedActive += 1;
      } else {
        insertedActive += 1;
      }
      activeById.set(
        normalized.marketId,
        existing && sameNormalizedMarketShape(existing, normalized)
          ? { ...existing, lastSyncedAt: syncTimestamp }
          : normalized
      );
      continue;
    }

    if (isMarketWithStatus(sourceMarket, "approved")) {
      const existing = upcomingById.get(normalized.marketId);
      if (existing) {
        updatedUpcoming += 1;
      } else {
        insertedUpcoming += 1;
      }
      upcomingById.set(
        normalized.marketId,
        existing && sameNormalizedMarketShape(existing, normalized)
          ? { ...existing, lastSyncedAt: syncTimestamp }
          : normalized
      );
    }
  }

  await activeRepository.save([...activeById.values()]);
  await upcomingRepository.save([...upcomingById.values()]);
  await syncStateRepository.setState(
    syncStateScope,
    buildNextSyncState({ sourceMarkets, syncedAt: syncTimestamp })
  );

  return {
    insertedActive,
    updatedActive,
    insertedUpcoming,
    updatedUpcoming,
    totalNewlyListed: candidates.length
  };
}
