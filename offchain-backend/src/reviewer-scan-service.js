import { generateMarketInterpretation } from "./llm-provider.js";
import { buildAdaptiveReviewWindow } from "./review-window-policy.js";

function buildRecommendation(llmOutput) {
  return llmOutput.ambiguity_score >= 0.5 ? "review" : "monitor";
}

function normalizeMarketText(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function buildMarketTextKey(market) {
  return normalizeMarketText(market?.resolution ?? market?.resolutionText ?? market?.title ?? "");
}

function isUpcomingMarket(market, now) {
  const closesAt = market?.closesAt ?? market?.endTime ?? market?.expiryDate ?? null;

  if (typeof closesAt !== "string" || closesAt.trim() === "") {
    return false;
  }

  const closesAtMs = Date.parse(closesAt);
  return Number.isFinite(closesAtMs) && closesAtMs > now.getTime();
}

function cloneScanForEvent({ sourceScan, jobId, eventId, createdAt }) {
  return {
    ...sourceScan,
    scanId: `scan_${eventId}_${createdAt}`,
    jobId: jobId ?? null,
    eventId,
    createdAt,
    reusedFromScanId: sourceScan.scanId,
    reusedFromEventId: sourceScan.eventId
  };
}

export async function createReviewerMarketScan({
  jobId,
  eventId,
  marketCacheRepository,
  reviewerScanRepository,
  now,
  llmRuntime,
  requireUpcomingOpenMarket = false,
  dedupeByMarketText = false,
  inFlightMarketTextScans = null
}) {
  const market = await marketCacheRepository.findByMarketId(eventId);

  if (!market) {
    const error = new Error("Event id must match an active synced market before a scan can run.");
    error.statusCode = 404;
    error.code = "UNSUPPORTED_EVENT_ID";
    throw error;
  }

  const scanNow = now();

  if (requireUpcomingOpenMarket && !isUpcomingMarket(market, scanNow)) {
    const error = new Error(
      "Event id must match an upcoming market that has not expired before a scan can run."
    );
    error.statusCode = 409;
    error.code = "MARKET_NOT_UPCOMING";
    throw error;
  }

  const marketTextKey = buildMarketTextKey(market);

  async function findReusableScan() {
    if (!dedupeByMarketText || marketTextKey === "") {
      return null;
    }

    const existingSameEvent = await reviewerScanRepository?.findLatestByEventId?.(eventId);

    if (existingSameEvent?.marketTextKey === marketTextKey) {
      return existingSameEvent;
    }

    const scans = (await reviewerScanRepository?.list?.()) ?? [];
    return (
      scans
        .filter((scan) => scan.marketTextKey === marketTextKey)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .at(0) ?? null
    );
  }

  async function createFreshScan() {
    const createdAt = scanNow.toISOString();
    const { llmOutput } = await generateMarketInterpretation({
      clarification: {
        clarificationId: null,
        eventId,
        question: `Review this market for ambiguity and suggest clarifying edits.`
      },
      market,
      llmRuntime,
      promptProfile: "review-upcoming-market"
    });
    const reviewWindow = buildAdaptiveReviewWindow({
      clarification: {
        llmOutput
      },
      market,
      now: new Date(createdAt)
    });
    const scan = {
      scanId: `scan_${eventId}_${createdAt}`,
      jobId: jobId ?? null,
      eventId,
      createdAt,
      ambiguity_score: llmOutput.ambiguity_score,
      recommendation: buildRecommendation(llmOutput),
      flagged_clauses: [llmOutput.cited_clause],
      suggested_market_text: llmOutput.suggested_market_text,
      suggested_note: llmOutput.suggested_note,
      review_window: reviewWindow,
      marketTextKey
    };

    await reviewerScanRepository.create(scan);

    return scan;
  }

  async function materializeScan() {
    const reusableScan = await findReusableScan();

    if (reusableScan) {
      if (reusableScan.eventId === eventId) {
        return reusableScan;
      }

      const reusedScan = cloneScanForEvent({
        sourceScan: reusableScan,
        jobId,
        eventId,
        createdAt: scanNow.toISOString()
      });
      await reviewerScanRepository.create(reusedScan);
      return reusedScan;
    }

    return createFreshScan();
  }

  if (!dedupeByMarketText || marketTextKey === "" || !(inFlightMarketTextScans instanceof Map)) {
    return materializeScan();
  }

  const inFlightScan = inFlightMarketTextScans.get(marketTextKey);

  if (inFlightScan) {
    const sourceScan = await inFlightScan;

    if (sourceScan.eventId === eventId) {
      return sourceScan;
    }

    const existingSameEvent = await reviewerScanRepository?.findLatestByEventId?.(eventId);

    if (existingSameEvent?.marketTextKey === marketTextKey) {
      return existingSameEvent;
    }

    const reusedScan = cloneScanForEvent({
      sourceScan,
      jobId,
      eventId,
      createdAt: scanNow.toISOString()
    });
    await reviewerScanRepository.create(reusedScan);
    return reusedScan;
  }

  const pendingScan = materializeScan();
  inFlightMarketTextScans.set(marketTextKey, pendingScan);

  try {
    return await pendingScan;
  } finally {
    if (inFlightMarketTextScans.get(marketTextKey) === pendingScan) {
      inFlightMarketTextScans.delete(marketTextKey);
    }
  }
}
