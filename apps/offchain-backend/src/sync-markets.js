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

async function syncMarketSet({
  repository,
  fetchMarkets,
  now = () => new Date(),
  includeMarket = () => true,
  totalKey
}) {
  const sourceMarkets = await fetchMarkets();
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
