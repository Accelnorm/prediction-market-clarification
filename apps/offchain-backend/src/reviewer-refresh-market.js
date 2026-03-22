function normalizeRefreshedMarket(sourceMarket, existingMarket, refreshedAt) {
  return {
    ...existingMarket,
    marketId: existingMarket.marketId,
    title: String(sourceMarket.title ?? existingMarket.title ?? ""),
    resolution: String(
      sourceMarket.resolution ?? sourceMarket.resolutionText ?? existingMarket.resolution ?? ""
    ),
    closesAt: String(
      sourceMarket.closesAt ?? sourceMarket.endTime ?? existingMarket.closesAt ?? ""
    ),
    slug: sourceMarket.slug ? String(sourceMarket.slug) : null,
    url: sourceMarket.url ? String(sourceMarket.url) : null,
    lastRefreshedAt: refreshedAt,
    ...(sourceMarket.activitySignal
      ? { activitySignal: String(sourceMarket.activitySignal) }
      : {})
  };
}

export async function refreshReviewerMarketData({
  eventId,
  marketCacheRepository,
  fetchReviewerMarketSource,
  now = () => new Date()
}) {
  const existingMarket = await marketCacheRepository.findByMarketId(eventId);

  if (!existingMarket) {
    const error = new Error("Market not found in the local cache.");
    error.statusCode = 404;
    error.code = "MARKET_NOT_FOUND";
    throw error;
  }

  if (typeof fetchReviewerMarketSource !== "function") {
    const error = new Error("Reviewer market refresh source is not configured.");
    error.statusCode = 503;
    error.code = "MARKET_REFRESH_UNAVAILABLE";
    throw error;
  }

  const sourceMarket = await fetchReviewerMarketSource(eventId);

  if (!sourceMarket) {
    const error = new Error("Market was not returned by the configured refresh source.");
    error.statusCode = 404;
    error.code = "MARKET_SOURCE_NOT_FOUND";
    throw error;
  }

  const sourceMarketId = String(sourceMarket.id ?? sourceMarket.marketId ?? eventId);

  if (sourceMarketId !== eventId) {
    const error = new Error("Configured refresh source returned a mismatched market identifier.");
    error.statusCode = 502;
    error.code = "MARKET_SOURCE_MISMATCH";
    throw error;
  }

  const refreshedMarket = normalizeRefreshedMarket(
    sourceMarket,
    existingMarket,
    now().toISOString()
  );
  await marketCacheRepository.upsert(refreshedMarket);

  return refreshedMarket;
}
