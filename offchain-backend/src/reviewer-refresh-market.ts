// @ts-nocheck
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

  const refreshedAt = now().toISOString();
  const normalizedSourceMarket = normalizeGeminiMarket(sourceMarket, refreshedAt);
  const sourceMarketId = String(
    sourceMarket.id ?? sourceMarket.marketId ?? normalizedSourceMarket.marketId ?? eventId
  );

  if (sourceMarketId !== eventId) {
    const error = new Error("Configured refresh source returned a mismatched market identifier.");
    error.statusCode = 502;
    error.code = "MARKET_SOURCE_MISMATCH";
    throw error;
  }

  const refreshedMarket = mergeNormalizedMarket(
    existingMarket,
    normalizedSourceMarket,
    refreshedAt
  );
  await marketCacheRepository.upsert(refreshedMarket);

  return refreshedMarket;
}
