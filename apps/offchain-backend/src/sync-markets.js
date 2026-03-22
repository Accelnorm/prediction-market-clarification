function isActiveMarket(market) {
  if (typeof market?.status === "string") {
    return market.status.toLowerCase() === "active";
  }

  if (typeof market?.active === "boolean") {
    return market.active;
  }

  return false;
}

function extractRichTextText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(extractRichTextText).filter(Boolean).join(" ").trim();
  }

  if (typeof value.value === "string") {
    return value.value;
  }

  if (Array.isArray(value.content)) {
    return value.content.map(extractRichTextText).filter(Boolean).join(" ").trim();
  }

  return "";
}

function normalizeMarket(market, lastSyncedAt) {
  const resolutionText = String(
    market.resolution ?? market.resolutionText ?? extractRichTextText(market.description)
  );
  const endTime = String(market.closesAt ?? market.endTime ?? market.expiryDate ?? "");

  return {
    marketId: String(market.id),
    title: String(market.title ?? ""),
    resolution: resolutionText,
    resolutionText,
    closesAt: endTime,
    endTime,
    slug: market.slug ? String(market.slug) : null,
    url: market.url ? String(market.url) : null,
    lastSyncedAt
  };
}

function sameMarketShape(left, right) {
  return (
    left.marketId === right.marketId &&
    left.title === right.title &&
    left.resolution === right.resolution &&
    left.resolutionText === right.resolutionText &&
    left.closesAt === right.closesAt &&
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
