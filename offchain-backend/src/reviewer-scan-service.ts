import { generateMarketInterpretation } from "./llm-provider.js";
import { buildAdaptiveReviewWindow } from "./review-window-policy.js";
import type { MarketRecord, ReviewerScan } from "./types.js";

function buildRecommendation(llmOutput: { ambiguity_score?: number }) {
  return (llmOutput.ambiguity_score ?? 0) >= 0.5 ? "review" : "monitor";
}

function normalizeMarketText(text: unknown) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeTemplateText(text: string) {
  return text
    .toLowerCase()
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g, "<month>")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/g, "<day>")
    .replace(/\b(today|tomorrow|yesterday|tonight|this year|next year|this month|next month)\b/g, "<relative_time>")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>")
    .replace(/\$\s?\d+(?:[.,]\d+)?/g, "<price>")
    .replace(/\b\d+(?:[.,]\d+)?%?\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildReviewerMarketTemplateKey(market: MarketRecord | Record<string, unknown>) {
  const title = normalizeTemplateText(String(market?.title ?? ""));
  const resolution = normalizeTemplateText(
    normalizeMarketText(market?.resolution ?? market?.resolutionText ?? market?.description ?? "")
  );
  const category = normalizeTemplateText(String(market?.category ?? ""));

  if (
    title.includes(" price ") ||
    title.endsWith(" price?") ||
    resolution.includes("price prediction event")
  ) {
    return "template:price-prediction";
  }

  if (category === "sports" && /\bvs\b/.test(title)) {
    return "template:sports-head-to-head";
  }

  if (
    category === "sports" &&
    (title.includes(" winner") || title.includes(" champion") || title.includes(" qualifiers"))
  ) {
    return "template:sports-outright";
  }

  return `exact:${resolution || title}`;
}

function buildMarketTextKey(market: MarketRecord) {
  return buildReviewerMarketTemplateKey(market);
}

function isUpcomingMarket(market: MarketRecord, now: Date) {
  const closesAt = market?.closesAt ?? market?.endTime ?? null;

  if (typeof closesAt !== "string" || closesAt.trim() === "") {
    return false;
  }

  const closesAtMs = Date.parse(closesAt);
  return Number.isFinite(closesAtMs) && closesAtMs > now.getTime();
}

function cloneScanForEvent({ sourceScan, jobId, eventId, createdAt }: { sourceScan: ReviewerScan; jobId: string | null; eventId: string; createdAt: string }) {
  return {
    ...sourceScan,
    scanId: `scan_${eventId}_${createdAt}`,
    jobId: jobId ?? null,
    eventId,
    createdAt,
    reusedFromScanId: sourceScan.scanId ?? null,
    reusedFromEventId: sourceScan.eventId
  };
}

export type CreateReviewerMarketScanOptions = {
  jobId: string | null;
  eventId: string;
  marketCacheRepository: {
    findByMarketId?: (marketId: string) => Promise<MarketRecord | null>;
  } | null | undefined;
  reviewerScanRepository: {
    create?: (scan: ReviewerScan) => Promise<unknown>;
    list?: () => Promise<ReviewerScan[]>;
    findLatestByEventId?: (eventId: string) => Promise<ReviewerScan | null>;
  } | null | undefined;
  now: () => Date;
  llmRuntime: unknown;
  requireUpcomingOpenMarket?: boolean;
  dedupeByMarketText?: boolean;
  inFlightMarketTextScans?: Map<string, Promise<ReviewerScan>> | null;
};

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
}: CreateReviewerMarketScanOptions) {
  const market = await marketCacheRepository?.findByMarketId?.(eventId);

  if (!market) {
    throw Object.assign(
      new Error("Event id must match an active synced market before a scan can run."),
      { statusCode: 404, code: "UNSUPPORTED_EVENT_ID" }
    );
  }

  const scanNow = now();

  if (requireUpcomingOpenMarket && !isUpcomingMarket(market, scanNow)) {
    throw Object.assign(
      new Error("Event id must match an upcoming market that has not expired before a scan can run."),
      { statusCode: 409, code: "MARKET_NOT_UPCOMING" }
    );
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
        .filter((scan: ReviewerScan) => scan.marketTextKey === marketTextKey)
        .sort((left: ReviewerScan, right: ReviewerScan) => right.createdAt.localeCompare(left.createdAt))
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
      llmRuntime: llmRuntime as Record<string, unknown>,
      promptProfile: "review-upcoming-market"
    });
    const reviewWindow = buildAdaptiveReviewWindow({
      clarification: {
        llmOutput: llmOutput as { ambiguity_score?: unknown }
      },
      market,
      now: new Date(createdAt)
    });
    const scan: ReviewerScan = {
      scanId: `scan_${eventId}_${createdAt}`,
      jobId: jobId ?? null,
      eventId,
      createdAt,
      ambiguity_score: (llmOutput as { ambiguity_score?: unknown }).ambiguity_score,
      recommendation: buildRecommendation(llmOutput as { ambiguity_score?: number }),
      flagged_clauses: [(llmOutput as { cited_clause?: unknown }).cited_clause],
      suggested_market_text: (llmOutput as { suggested_market_text?: unknown }).suggested_market_text,
      suggested_note: (llmOutput as { suggested_note?: unknown }).suggested_note,
      review_window: reviewWindow,
      marketTextKey
    };

    await reviewerScanRepository?.create?.(scan);

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
      await reviewerScanRepository?.create?.(reusedScan);
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
    await reviewerScanRepository?.create?.(reusedScan);
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
