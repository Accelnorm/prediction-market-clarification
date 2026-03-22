function isActiveMarket(market) {
  if (typeof market?.status === "string") {
    return market.status.toLowerCase() === "active";
  }

  if (typeof market?.active === "boolean") {
    return market.active;
  }

  return false;
}

function normalizeMarket(market, lastSyncedAt) {
  return {
    marketId: String(market.id),
    title: String(market.title ?? ""),
    resolutionText: String(market.resolution ?? market.resolutionText ?? ""),
    endTime: String(market.closesAt ?? market.endTime ?? ""),
    slug: market.slug ? String(market.slug) : null,
    url: market.url ? String(market.url) : null,
    lastSyncedAt
  };
}

function sameMarketShape(left, right) {
  return (
    left.marketId === right.marketId &&
    left.title === right.title &&
    left.resolutionText === right.resolutionText &&
    left.endTime === right.endTime &&
    left.slug === right.slug &&
    left.url === right.url
  );
}

export async function syncMarkets({ repository, fetchMarkets, now = () => new Date() }) {
  const sourceMarkets = await fetchMarkets();
  const activeMarkets = sourceMarkets.filter(isActiveMarket);
  const cache = await repository.load();
  const marketsById = new Map(cache.markets.map((market) => [market.marketId, market]));
  const lastSyncedAt = now().toISOString();

  let inserted = 0;
  let updated = 0;

  for (const sourceMarket of activeMarkets) {
    const normalized = normalizeMarket(sourceMarket, lastSyncedAt);
    const existing = marketsById.get(normalized.marketId);

    if (!existing) {
      inserted += 1;
      marketsById.set(normalized.marketId, normalized);
      continue;
    }

    updated += 1;
    marketsById.set(
      normalized.marketId,
      sameMarketShape(existing, normalized)
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
    totalActive: activeMarkets.length
  };
}
