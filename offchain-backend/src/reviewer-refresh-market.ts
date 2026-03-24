import {
  mergeNormalizedMarket,
  normalizeGeminiMarket
} from "./gemini-market-normalizer.js";

export async function refreshReviewerMarketData({
  eventId,
  marketCacheRepository,
  fetchReviewerMarketSource,
  now = () => new Date()
}) {
  const existingMarket = await marketCacheRepository.findByMarketId(eventId);

  if (!existingMarket) {
    throw Object.assign(new Error("Market not found in the local cache."), { statusCode: 404, code: "MARKET_NOT_FOUND" });
  }

  if (typeof fetchReviewerMarketSource !== "function") {
    throw Object.assign(new Error("Reviewer market refresh source is not configured."), { statusCode: 503, code: "MARKET_REFRESH_UNAVAILABLE" });
  }

  const sourceMarket = await fetchReviewerMarketSource(eventId);

  if (!sourceMarket) {
    throw Object.assign(new Error("Market was not returned by the configured refresh source."), { statusCode: 404, code: "MARKET_SOURCE_NOT_FOUND" });
  }

  const refreshedAt = now().toISOString();
  const normalizedSourceMarket = normalizeGeminiMarket(sourceMarket, refreshedAt);
  const sourceMarketId = String(
    sourceMarket.id ?? sourceMarket.marketId ?? normalizedSourceMarket.marketId ?? eventId
  );

  if (sourceMarketId !== eventId) {
    throw Object.assign(new Error("Configured refresh source returned a mismatched market identifier."), { statusCode: 502, code: "MARKET_SOURCE_MISMATCH" });
  }

  const refreshedMarket = mergeNormalizedMarket(
    existingMarket,
    normalizedSourceMarket,
    refreshedAt
  );
  await marketCacheRepository.upsert(refreshedMarket);

  return refreshedMarket;
}
