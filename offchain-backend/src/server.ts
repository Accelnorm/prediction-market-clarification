import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  fetchPredictionMarketEventByTicker,
  fetchTradesForSymbol as fetchDefaultTradesForSymbol
} from "./gemini-markets-source.js";
import { runAutomaticClarificationPipeline as runDefaultAutomaticClarificationPipeline } from "./automatic-llm-pipeline.js";
import type { RunAutomaticClarificationPipelineOptions } from "./automatic-llm-pipeline.js";
import { buildClarificationTiming } from "./clarification-timing.js";
import { refreshReviewerMarketData } from "./reviewer-refresh-market.js";
import { createTelegramClarificationRequest } from "./telegram-request-flow.js";
import {
  assertTelegramWebhookSecret,
  sendTelegramMessage as sendDefaultTelegramMessage
} from "./telegram-bot-client.js";
import type { SendTelegramMessageOptions } from "./telegram-bot-client.js";
import {
  buildTelegramDeliveryPayload,
  parseTelegramStatusUpdate
} from "./telegram-status-delivery.js";
import { buildAdaptiveReviewWindow } from "./review-window-policy.js";
import { createReviewerMarketScan } from "./reviewer-scan-service.js";
import type { CreateReviewerMarketScanOptions } from "./reviewer-scan-service.js";
import { parseClarificationRequestInput } from "./x402-paid-clarification.js";
import { buildX402PaymentRequiredPayload } from "./x402-payment-challenge.js";
import { buildX402PaymentRequiredHeader } from "./x402-payment-challenge.js";
import type { BuildPaymentRequirementsOptions } from "./x402-payment-challenge.js";
import { loadX402PaymentConfig } from "./x402-payment-config.js";
import type { X402PaymentConfig } from "./x402-payment-challenge.js";
import {
  extractX402PaymentCandidate,
  verifyClarificationPayment as verifyDefaultClarificationPayment
} from "./x402-payment-verifier.js";
import type { VerifyClarificationPaymentOptions } from "./x402-payment-verifier.js";
import type { ArtifactRecord, BackgroundJob, ClarificationRequest, MarketRecord, ReviewerScan, VerifiedPayment } from "./types.js";

interface HttpError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && typeof (error as HttpError).statusCode === "number";
}

interface AppServer extends http.Server {
  resumeRecoverableBackgroundJobs: () => Promise<number>;
  markShuttingDown: () => void;
}

interface VerifiedPaymentResult {
  paymentProof: string;
  paymentReference?: string | null;
  paymentAmount?: string | null;
  paymentAsset?: string | null;
  paymentMint?: string | null;
  paymentCluster?: string | null;
  paymentRecipient?: string | null;
  paymentTransactionSignature?: string | null;
  paymentVerifiedAt?: string | null;
  paymentSettledAt?: string | null;
  paymentResponseHeader?: string | null;
  verificationSource?: string | null;
  [key: string]: unknown;
}

interface FundingHistoryEntry {
  contributor: string;
  amount: string;
  timestamp: string;
  reference: string | null;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown, headers: Record<string, string> = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendNotFound(response: ServerResponse) {
  sendJson(response, 404, {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found."
    }
  });
}

interface LoggerLike {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
}

function buildLogger(logger: LoggerLike = console) {
  return {
    info(message: string, fields: Record<string, unknown> = {}) {
      (logger.info ?? logger.log).call(logger, JSON.stringify({ level: "info", message, ...fields }));
    },
    warn(message: string, fields: Record<string, unknown> = {}) {
      (logger.warn ?? logger.log).call(logger, JSON.stringify({ level: "warn", message, ...fields }));
    },
    error(message: string, fields: Record<string, unknown> = {}) {
      (logger.error ?? logger.log).call(logger, JSON.stringify({ level: "error", message, ...fields }));
    }
  };
}

function buildRequestContext(request: IncomingMessage) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedClient =
    typeof forwardedFor === "string" && forwardedFor.trim() !== ""
      ? forwardedFor.split(",")[0].trim()
      : null;

  return {
    requestId: randomUUID().replace(/-/g, "").slice(0, 16),
    clientAddress: forwardedClient ?? request.socket.remoteAddress ?? "unknown"
  };
}

function createInMemoryRateLimiter({
  windowMs = 60_000,
  maxRequests = 30
}: { windowMs?: number; maxRequests?: number } = {}) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string, now: number = Date.now()) {
      const existingBucket = buckets.get(key);

      if (!existingBucket || existingBucket.resetAt <= now) {
        buckets.set(key, {
          count: 1,
          resetAt: now + windowMs
        });
        return { allowed: true };
      }

      if (existingBucket.count >= maxRequests) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existingBucket.resetAt - now) / 1000))
        };
      }

      existingBucket.count += 1;
      return { allowed: true };
    }
  };
}

function hasReviewerAccess(request: IncomingMessage, reviewerAuthToken: string | null | undefined) {
  if (!reviewerAuthToken) {
    return false;
  }

  return request.headers["x-reviewer-token"] === reviewerAuthToken;
}

function sendReviewerAuthRequired(response: ServerResponse) {
  sendJson(response, 401, {
    ok: false,
    error: {
      code: "REVIEWER_AUTH_REQUIRED",
      message: "Reviewer authentication is required for this route."
    }
  });
}

function buildPublicClarificationPayload(clarification: ClarificationRequest) {
  const payload: Record<string, unknown> = {
    clarificationId: clarification.clarificationId,
    status: clarification.status,
    eventId: clarification.eventId,
    question: clarification.question,
    createdAt: clarification.createdAt,
    updatedAt: clarification.updatedAt ?? clarification.createdAt
  };

  if (clarification?.timing && typeof clarification.timing === "object") {
    payload.timing = clarification.timing;
  }

  if (clarification.status === "completed" && clarification.llmOutput) {
    payload.llmOutput = clarification.llmOutput;
  }

  if (clarification.status === "failed") {
    payload.errorMessage = clarification.errorMessage ?? null;
    payload.retryable = clarification.retryable ?? false;
  }

  return payload;
}

function parseBoundedWaitOptions(requestUrl: URL) {
  const waitValue = String(requestUrl.searchParams.get("wait") ?? "").toLowerCase();

  if (!["1", "true"].includes(waitValue)) {
    return null;
  }

  const rawTimeoutMs = Number.parseInt(requestUrl.searchParams.get("timeoutMs") ?? "", 10);

  return {
    timeoutMs: Number.isFinite(rawTimeoutMs)
      ? Math.max(0, Math.min(rawTimeoutMs, 15_000))
      : 10_000
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatWorkflowLabel(state: string) {
  return state
    .split("_")
    .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeFundingHistory(history: FundingHistoryEntry[] = []) {
  return history
    .filter(
      (entry: FundingHistoryEntry) =>
        entry &&
        typeof entry.contributor === "string" &&
        entry.contributor.trim() !== "" &&
        typeof entry.amount === "string" &&
        entry.amount !== "" &&
        typeof entry.timestamp === "string" &&
        entry.timestamp !== ""
    )
    .map((entry: FundingHistoryEntry) => ({
      contributor: entry.contributor,
      amount: Number.parseFloat(entry.amount).toFixed(2),
      timestamp: entry.timestamp,
      reference: entry.reference ?? null
    }))
    .sort((left: FundingHistoryEntry, right: FundingHistoryEntry) => right.timestamp.localeCompare(left.timestamp));
}

function buildFundingDetailsFromHistory(history: FundingHistoryEntry[] = [], targetAmount: string = "1.00") {
  const normalizedHistory = normalizeFundingHistory(history);

  if (normalizedHistory.length === 0) {
    return {
      targetAmount,
      raisedAmount: "0.00",
      contributorCount: 0,
      fundingState: "unfunded",
      history: []
    };
  }

  const raisedAmount = normalizedHistory
    .reduce((total: number, entry: FundingHistoryEntry) => total + Number.parseFloat(entry.amount), 0)
    .toFixed(2);
  const contributorCount = new Set(
    normalizedHistory.map((entry: FundingHistoryEntry) => entry.contributor)
  ).size;
  const fundingState =
    Number.parseFloat(raisedAmount) >= Number.parseFloat(targetAmount)
      ? "funded"
      : "funding_in_progress";

  return {
    targetAmount,
    raisedAmount,
    contributorCount,
    fundingState,
    history: normalizedHistory
  };
}

function buildFundingDetailsFromClarifications(clarifications: ClarificationRequest[] = []) {
  const fundingProgress = buildFundingProgress(clarifications);
  const history = clarifications
    .filter(
      (clarification: ClarificationRequest) =>
        typeof clarification.paymentAmount === "string" && clarification.paymentAmount !== ""
    )
    .map((clarification: ClarificationRequest) => ({
      contributor: (clarification.requesterId ?? clarification.paymentReference ?? "unknown") as string,
      amount: clarification.paymentAmount as string,
      timestamp: (clarification.paymentVerifiedAt ?? clarification.createdAt) as string,
      reference: (clarification.paymentReference ?? null) as string | null
    }))
    .sort((left: FundingHistoryEntry, right: FundingHistoryEntry) => right.timestamp.localeCompare(left.timestamp));

  return {
    ...fundingProgress,
    history
  };
}

interface StoredFundingData {
  history?: FundingHistoryEntry[];
  targetAmount?: string;
}

function buildFundingDetails(clarification: ClarificationRequest, relatedClarifications: ClarificationRequest[] = []) {
  const funding = clarification?.funding as StoredFundingData | undefined;
  if (funding && Array.isArray(funding.history)) {
    return buildFundingDetailsFromHistory(
      funding.history,
      funding.targetAmount ?? "1.00"
    );
  }

  return buildFundingDetailsFromClarifications(relatedClarifications);
}

function buildStoredFundingDetails(clarification: ClarificationRequest) {
  const funding = clarification?.funding as StoredFundingData | undefined;
  if (funding && Array.isArray(funding.history)) {
    return buildFundingDetailsFromHistory(
      funding.history,
      funding.targetAmount ?? "1.00"
    );
  }

  return buildFundingDetailsFromHistory([]);
}

function buildReviewerVotePayload(clarification: ClarificationRequest) {
  const status = clarification.reviewerWorkflowStatus ?? "not_started";

  return {
    status,
    label: formatWorkflowLabel(status),
    placeholder: true,
    summary: "Off-chain placeholder until panel voting is implemented.",
    updatedAt: clarification.finalizedAt ?? clarification.updatedAt ?? clarification.createdAt
  };
}

function buildReviewerClarificationPayload({
  clarification,
  adaptiveReviewWindow,
  market,
  relatedClarifications
}: { clarification: ClarificationRequest; adaptiveReviewWindow: Record<string, unknown>; market: unknown; relatedClarifications: ClarificationRequest[] }) {
  const clarificationPayload: Record<string, unknown> = {
    ...buildPublicClarificationPayload(clarification),
    llmOutput: clarification.llmOutput ?? null,
    llmTrace: clarification.llmTrace ?? null,
    market: buildReviewerMarketPayload(market as Record<string, unknown> | null, clarification.eventId),
    funding: buildFundingDetails(clarification, relatedClarifications),
    vote: buildReviewerVotePayload(clarification),
    ...adaptiveReviewWindow
  };

  if (clarification.finalEditedText || clarification.finalNote || clarification.finalizedAt) {
    clarificationPayload.finalization = {
      finalEditedText: clarification.finalEditedText ?? null,
      finalNote: clarification.finalNote ?? null,
      finalizedAt: clarification.finalizedAt ?? null,
      finalizedBy: clarification.finalizedBy ?? null
    };
  }

  if (clarification.artifactCid && clarification.artifactUrl) {
    clarificationPayload.artifact = {
      cid: clarification.artifactCid,
      url: clarification.artifactUrl
    };
  }

  return clarificationPayload;
}

function buildReviewerMarketPayload(market: Record<string, unknown> | null | undefined, fallbackMarketId: string | null = null) {
  const payload: Record<string, unknown> = {
    marketId: market?.marketId ?? fallbackMarketId ?? null,
    title: market?.title ?? null,
    resolutionText: market?.resolution ?? market?.resolutionText ?? null,
    endTime: market?.closesAt ?? market?.endTime ?? null,
    slug: market?.slug ?? null,
    url: market?.url ?? null
  };

  if (typeof market?.ticker === "string" && market.ticker !== "") {
    payload.ticker = market.ticker;
  }

  if (typeof market?.description === "string" && market.description !== "") {
    payload.description = market.description;
  }

  if (typeof market?.category === "string" && market.category !== "") {
    payload.category = market.category;
  }

  if (market?.subcategory) {
    payload.subcategory = market.subcategory;
  }

  if (Array.isArray(market?.tags) && market.tags.length > 0) {
    payload.tags = market.tags;
  }

  if (typeof market?.status === "string" && market.status !== "") {
    payload.status = market.status;
  }

  if (typeof market?.createdAt === "string" && market.createdAt !== "") {
    payload.createdAt = market.createdAt;
  }

  if (typeof market?.effectiveDate === "string" && market.effectiveDate !== "") {
    payload.effectiveDate = market.effectiveDate;
  }

  if (typeof market?.expiryDate === "string" && market.expiryDate !== "") {
    payload.expiryDate = market.expiryDate;
  }

  if (typeof market?.resolvedAt === "string" && market.resolvedAt !== "") {
    payload.resolvedAt = market.resolvedAt;
  }

  if (typeof market?.termsLink === "string" && market.termsLink !== "") {
    payload.termsLink = market.termsLink;
  }

  if (typeof market?.volumeUsd === "string" && market.volumeUsd !== "") {
    payload.volumeUsd = market.volumeUsd;
  }

  if (typeof market?.liquidityUsd === "string" && market.liquidityUsd !== "") {
    payload.liquidityUsd = market.liquidityUsd;
  }

  if (Array.isArray(market?.contracts) && market.contracts.length > 0) {
    payload.contracts = market.contracts;
  }

  return payload;
}

function buildReviewerActionDetails(action: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(action).filter(([key]) => !["type", "actor", "timestamp"].includes(key))
  );
}

function buildClarificationAuditTimeline({ clarification, artifact }: { clarification: ClarificationRequest; artifact: Record<string, unknown> | null | undefined }) {
  const timeline: Record<string, unknown>[] = [];

  for (const entry of Array.isArray(clarification.statusHistory)
    ? clarification.statusHistory
    : []) {
    timeline.push({
      type: "status_changed",
      timestamp: entry.timestamp,
      status: entry.status
    });
  }

  const llmTrace = clarification.llmTrace as Record<string, unknown> | null | undefined;
  if (llmTrace?.requestedAt) {
    timeline.push({
      type: "llm_requested",
      timestamp: llmTrace.requestedAt as string,
      promptTemplateVersion: llmTrace.promptTemplateVersion ?? null,
      modelId: llmTrace.modelId ?? null,
      processingVersion: llmTrace.processingVersion ?? null
    });
  }

  if (artifact?.cid && artifact?.url) {
    timeline.push({
      type: "artifact_published",
      timestamp: artifact.generatedAtUtc ?? clarification.updatedAt ?? clarification.createdAt,
      cid: artifact.cid,
      url: artifact.url
    });
  }

  for (const contribution of buildStoredFundingDetails(clarification).history) {
    timeline.push({
      type: "funding_contribution_recorded",
      timestamp: contribution.timestamp,
      contributor: contribution.contributor,
      amount: contribution.amount,
      reference: contribution.reference ?? null
    });
  }

  for (const action of Array.isArray(clarification.reviewerActions)
    ? clarification.reviewerActions
    : []) {
    timeline.push({
      type: "reviewer_action",
      timestamp: action.timestamp,
      action: action.type,
      actor: action.actor ?? null,
      details: buildReviewerActionDetails(action)
    });
  }

  const priority: Record<string, number> = {
    status_changed: 1,
    llm_requested: 2,
    artifact_published: 3,
    reviewer_action: 4,
    funding_contribution_recorded: 5
  };

  return timeline.sort((left: Record<string, unknown>, right: Record<string, unknown>) => {
    const leftTimestamp = left.timestamp as string;
    const rightTimestamp = right.timestamp as string;
    const timestampComparison = leftTimestamp.localeCompare(rightTimestamp);

    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return (priority[left.type as string] ?? 99) - (priority[right.type as string] ?? 99);
  });
}

function buildClarificationAuditPayload({ clarification, artifact }: { clarification: ClarificationRequest; artifact: Record<string, unknown> | null | undefined }) {
  return {
    clarificationId: clarification.clarificationId,
    eventId: clarification.eventId ?? null,
    request: {
      requestId: clarification.requestId ?? null,
      source: clarification.source ?? null,
      requesterId: clarification.requesterId ?? null,
      question: clarification.question ?? null,
      normalizedInput: clarification.normalizedInput ?? null,
      createdAt: clarification.createdAt ?? null
    },
    payment: {
      amount: clarification.paymentAmount ?? null,
      asset: clarification.paymentAsset ?? null,
      reference: clarification.paymentReference ?? null,
      proof: clarification.paymentProof ?? null,
      verifiedAt: clarification.paymentVerifiedAt ?? null
    },
    statusHistory: Array.isArray(clarification.statusHistory)
      ? clarification.statusHistory
      : [],
    llm: {
      output: clarification.llmOutput ?? null,
      trace: clarification.llmTrace ?? null
    },
    artifact: artifact
      ? {
          cid: artifact.cid,
          url: artifact.url,
          generatedAtUtc: artifact.generatedAtUtc ?? null
        }
      : null,
    funding: buildStoredFundingDetails(clarification),
    reviewerActions: Array.isArray(clarification.reviewerActions)
      ? clarification.reviewerActions
      : [],
    finalization: {
      reviewerWorkflowStatus: clarification.reviewerWorkflowStatus ?? null,
      finalEditedText: clarification.finalEditedText ?? null,
      finalNote: clarification.finalNote ?? null,
      finalizedAt: clarification.finalizedAt ?? null,
      finalizedBy: clarification.finalizedBy ?? null
    },
    timeline: buildClarificationAuditTimeline({ clarification, artifact })
  };
}

const REVIEWER_QUEUE_FILTERS = [
  { key: "needs_scan", label: "Needs Scan" },
  { key: "high_ambiguity", label: "High Ambiguity" },
  { key: "paid", label: "Paid" },
  { key: "near_expiry", label: "Near Expiry" },
  { key: "awaiting_panel_vote", label: "Awaiting Panel Vote" },
  { key: "finalized", label: "Finalized" }
];

function buildFundingProgress(clarifications: ClarificationRequest[] = []) {
  const fundedClarifications = clarifications.filter(
    (clarification: ClarificationRequest) =>
      typeof clarification.paymentAmount === "string" && clarification.paymentAmount !== ""
  );

  if (fundedClarifications.length === 0) {
    return {
      raisedAmount: "0.00",
      targetAmount: "1.00",
      contributorCount: 0,
      fundingState: "unfunded"
    };
  }

  const raisedAmount = fundedClarifications
    .reduce((total: number, clarification: ClarificationRequest) => {
      const parsedAmount = Number.parseFloat(clarification.paymentAmount as string);
      return total + (Number.isFinite(parsedAmount) ? parsedAmount : 0);
    }, 0)
    .toFixed(2);
  const contributorCount = new Set(
    fundedClarifications.map(
      (clarification: ClarificationRequest) => clarification.requesterId ?? clarification.paymentReference
    )
  ).size;
  const fundingState =
    Number.parseFloat(raisedAmount) >= 1 ? "funded" : "funding_in_progress";

  return {
    raisedAmount,
    targetAmount: "1.00",
    contributorCount,
    fundingState
  };
}

function buildQueueFundingProgress(latestClarification: ClarificationRequest | null, clarifications: ClarificationRequest[] = []) {
  return latestClarification?.funding
    ? buildFundingDetails(latestClarification, clarifications)
    : buildFundingProgress(clarifications);
}

function parseReviewerFundingContributionPayload(payload: Record<string, unknown>) {
  const contributor = String(payload?.contributor ?? "").trim();
  const amount = String(payload?.amount ?? "").trim();
  const reference =
    payload?.reference === undefined || payload?.reference === null
      ? null
      : String(payload.reference).trim() || null;

  if (!contributor) {
    throw Object.assign(new Error("Contributor is required."), { statusCode: 400, code: "INVALID_FUNDING_CONTRIBUTOR" });
  }

  const parsedAmount = Number.parseFloat(amount);

  if (!amount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw Object.assign(new Error("Funding amount must be a positive decimal string."), { statusCode: 400, code: "INVALID_FUNDING_AMOUNT" });
  }

  return {
    contributor,
    amount: parsedAmount.toFixed(2),
    reference
  };
}

function buildQueueStates({ latestScan, fundingProgress, reviewWindow, voteStatus }: { latestScan: Record<string, unknown> | null; fundingProgress: { fundingState: string }; reviewWindow: { time_to_end_bucket: string }; voteStatus: string }) {
  const queueStates: string[] = [];

  if (!latestScan) {
    queueStates.push("needs_scan");
  }

  if (((latestScan?.ambiguity_score as number | undefined) ?? 0) >= 0.7) {
    queueStates.push("high_ambiguity");
  }

  if (fundingProgress.fundingState !== "unfunded") {
    queueStates.push("paid");
  }

  if (["lt_6h", "lt_24h"].includes(reviewWindow.time_to_end_bucket)) {
    queueStates.push("near_expiry");
  }

  if (voteStatus === "awaiting_panel_vote") {
    queueStates.push("awaiting_panel_vote");
  }

  if (voteStatus === "finalized") {
    queueStates.push("finalized");
  }

  return queueStates;
}

function buildReviewerQueueFilters(queue: Array<{ queueStates: string[] }>) {
  return REVIEWER_QUEUE_FILTERS.map((filter) => ({
    ...filter,
    count: queue.filter((item) => item.queueStates.includes(filter.key)).length
  }));
}

function buildReviewerScanListItem(scan: Record<string, unknown>) {
  return {
    scanId: scan.scanId,
    eventId: scan.eventId,
    createdAt: scan.createdAt,
    ambiguityScore: scan.ambiguity_score,
    recommendation: scan.recommendation,
    reviewWindow: scan.review_window
  };
}

function buildPrelaunchQueueItem({ market, latestScan, now, globalTermsUrls }: { market: Record<string, unknown>; latestScan: Record<string, unknown> | null; now: Date; globalTermsUrls: Set<string> }) {
  const reviewWindow =
    latestScan?.review_window ??
    buildAdaptiveReviewWindow({
      clarification: {
        llmOutput: {
          ambiguity_score: 0
        }
      },
      market,
      now
    });

  const termsLink = typeof market.termsLink === "string" ? market.termsLink : null;
  const globalTerms = termsLink !== null && globalTermsUrls.has(termsLink);

  return {
    eventId: market.marketId,
    marketTitle: market.title,
    ticker: market.ticker ?? null,
    category: market.category ?? null,
    status: market.status ?? null,
    startsAt: market.effectiveDate ?? null,
    endTime: market.closesAt,
    ambiguityScore: latestScan?.ambiguity_score ?? null,
    needsScan: !globalTerms && latestScan === null,
    globalTerms,
    latestScanId: latestScan?.scanId ?? null,
    reviewWindow,
    contracts: Array.isArray(market.contracts) ? market.contracts : []
  };
}

function isFutureUpcomingMarket(market: Record<string, unknown>, referenceNow: Date) {
  const closesAt = market?.closesAt ?? market?.endTime ?? market?.expiryDate ?? null;

  if (typeof closesAt !== "string" || closesAt.trim() === "") {
    return false;
  }

  const closesAtMs = Date.parse(closesAt);
  return Number.isFinite(closesAtMs) && closesAtMs > referenceNow.getTime();
}

function parseReviewerFinalizationPayload(payload: Record<string, unknown>) {
  const finalEditedText = String(payload?.finalEditedText ?? "").trim();
  const finalNote = String(payload?.finalNote ?? "").trim();
  const reviewerId = String(payload?.reviewerId ?? "system").trim();

  if (!finalEditedText) {
    throw Object.assign(new Error("Final edited text is required."), { statusCode: 400, code: "INVALID_FINAL_EDITED_TEXT" });
  }

  if (!finalNote) {
    throw Object.assign(new Error("Final note is required."), { statusCode: 400, code: "INVALID_FINAL_NOTE" });
  }

  if (!reviewerId) {
    throw Object.assign(new Error("Reviewer identity is required."), { statusCode: 400, code: "INVALID_REVIEWER_ID" });
  }

  return {
    finalEditedText,
    finalNote,
    reviewerId
  };
}

function parseReviewerWorkflowPayload(payload: Record<string, unknown>) {
  const reviewerId = String(payload?.reviewerId ?? "system").trim();

  if (!reviewerId) {
    throw Object.assign(new Error("Reviewer identity is required."), { statusCode: 400, code: "INVALID_REVIEWER_ID" });
  }

  return {
    reviewerId
  };
}

function buildBackgroundJobPayload(job: Record<string, unknown>) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    retryable: job.retryable,
    target: job.target
  };
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");

  if (!body) {
    return {};
  }

  return JSON.parse(body);
}

interface ClarificationRequestRepo {
  create: (req: ClarificationRequest) => Promise<ClarificationRequest | null>;
  findByTelegramIdentifiers: (opts: { telegramChatId?: string | null; telegramUserId?: string | null }) => Promise<ClarificationRequest[]>;
  findByRequestId: (id: string) => Promise<ClarificationRequest | null>;
  findByClarificationId: (id: string) => Promise<ClarificationRequest | null>;
  findByPaymentProof: (proof: string) => Promise<ClarificationRequest | null>;
  findByEventId: (id: string) => Promise<ClarificationRequest[]>;
  list: () => Promise<ClarificationRequest[]>;
  updateStatus: (id: string, updates: Partial<ClarificationRequest>) => Promise<ClarificationRequest | null>;
  updateByClarificationId: (id: string, updates: Partial<ClarificationRequest>) => Promise<ClarificationRequest | null>;
}

interface ArtifactRepo {
  createArtifact?: (input: Record<string, unknown>) => Promise<ArtifactRecord | unknown>;
  findByCid?: (cid: string) => Promise<ArtifactRecord | Record<string, unknown> | null>;
}

interface BackgroundJobRepo {
  create?: (job: BackgroundJob) => Promise<BackgroundJob>;
  findByJobId?: (id: string) => Promise<BackgroundJob | null>;
  updateByJobId?: (id: string, updates: Partial<BackgroundJob>) => Promise<BackgroundJob | null>;
  listRecoverable?: () => Promise<BackgroundJob[]>;
}

interface ReviewerScanRepo {
  list?: () => Promise<ReviewerScan[]>;
  findLatestByEventId?: (id: string) => Promise<ReviewerScan | null>;
}

interface CategoryCatalogRepo {
  getCatalog?: (scope: string) => Promise<{ categories: string[]; updatedAt: string | null }>;
}

interface MarketCacheRepo {
  list?: () => Promise<MarketRecord[]>;
  findByMarketId?: (id: string) => Promise<MarketRecord | null>;
  upsert?: (market: MarketRecord) => Promise<MarketRecord>;
}

interface VerifiedPaymentRepo {
  create?: (payment: VerifiedPayment) => Promise<VerifiedPayment | undefined>;
  findByPaymentProof?: (proof: string) => Promise<VerifiedPayment | null>;
  updateByPaymentProof?: (proof: string, updates: Partial<VerifiedPayment>) => Promise<VerifiedPayment | null>;
}

interface Phase1CoordinatorRepo {
  createPaidClarification: (opts: { clarification: ClarificationRequest; verifiedPayment: VerifiedPayment; backgroundJob: BackgroundJob }) => Promise<{ created: boolean; clarification: ClarificationRequest; job: BackgroundJob | null }>;
}

interface SkipScanTermsRepo {
  list: () => Promise<string[]>;
  add: (url: string) => Promise<string[]>;
  remove: (url: string) => Promise<string[]>;
}

interface CreateServerOptions {
  clarificationRequestRepository: ClarificationRequestRepo;
  artifactRepository?: ArtifactRepo | null;
  artifactPublisher?: unknown;
  backgroundJobRepository?: BackgroundJobRepo | null;
  reviewerScanRepository?: ReviewerScanRepo | null;
  categoryCatalogRepository?: CategoryCatalogRepo | null;
  marketCacheRepository?: MarketCacheRepo | null;
  upcomingMarketCacheRepository?: MarketCacheRepo | null;
  upcomingReviewerScanRepository?: ReviewerScanRepo | null;
  upcomingCategoryCatalogRepository?: CategoryCatalogRepo | null;
  tradeActivityRepository?: unknown;
  now: () => Date;
  createRequestId?: () => string;
  createClarificationId?: () => string;
  createBackgroundJobId?: () => string;
  llmTraceability?: unknown;
  llmRuntime?: unknown;
  reviewerAuthToken?: string | null;
  telegramWebhookSecret?: string | null;
  telegramBotToken?: string | null;
  telegramBotApiBaseUrl?: string | null | undefined;
  x402PaymentConfig?: X402PaymentConfig & Record<string, unknown>;
  verifiedPaymentRepository?: VerifiedPaymentRepo | null;
  phase1Coordinator?: Phase1CoordinatorRepo | null;
  skipScanTermsRepository?: SkipScanTermsRepo | null;
  verifyX402Payment?: (opts: VerifyClarificationPaymentOptions) => Promise<unknown>;
  buildX402PaymentChallenge?: (opts: BuildPaymentRequirementsOptions) => unknown;
  fetchReviewerMarketSource?: ((eventId: string) => Promise<Record<string, unknown> | null>) | null;
  fetchTradesForSymbol?: (symbol: string, opts?: Record<string, unknown>) => Promise<unknown[]>;
  sendTelegramMessage?: (opts: SendTelegramMessageOptions) => Promise<unknown>;
  runAutomaticClarificationPipeline?: (opts: RunAutomaticClarificationPipelineOptions) => Promise<unknown>;
  runReviewerMarketScan?: (opts: CreateReviewerMarketScanOptions) => Promise<unknown>;
  clarificationFinalityConfig?: Record<string, unknown>;
  enablePhase2Routes?: boolean;
  enableTelegramRoutes?: boolean;
  logger?: LoggerLike;
  clarifyRateLimiter?: { check: (key: string, now?: number) => { allowed: boolean; retryAfterSeconds?: number } } | null;
  readinessCheck?: () => Promise<{ ok: boolean; checks: Record<string, string> }>;
}

export function createServer({
  clarificationRequestRepository,
  artifactRepository = null,
  artifactPublisher = null,
  backgroundJobRepository = null,
  reviewerScanRepository = null,
  categoryCatalogRepository = null,
  marketCacheRepository = null,
  upcomingMarketCacheRepository = null,
  upcomingReviewerScanRepository = null,
  upcomingCategoryCatalogRepository = null,
  tradeActivityRepository = null,
  now,
  createRequestId = (() => randomUUID()) as () => string,
  createClarificationId = (() => randomUUID()) as () => string,
  createBackgroundJobId = (() => randomUUID()) as () => string,
  llmTraceability = undefined,
  llmRuntime = undefined,
  reviewerAuthToken = null,
  telegramWebhookSecret = null,
  telegramBotToken = null,
  telegramBotApiBaseUrl = undefined,
  x402PaymentConfig = loadX402PaymentConfig(),
  verifiedPaymentRepository = null,
  phase1Coordinator = null,
  skipScanTermsRepository = null,
  verifyX402Payment = verifyDefaultClarificationPayment,
  buildX402PaymentChallenge = buildX402PaymentRequiredPayload,
  fetchReviewerMarketSource = null,
  fetchTradesForSymbol = fetchDefaultTradesForSymbol,
  sendTelegramMessage = sendDefaultTelegramMessage,
  runAutomaticClarificationPipeline = runDefaultAutomaticClarificationPipeline,
  runReviewerMarketScan = createReviewerMarketScan,
  clarificationFinalityConfig = {
    mode: "static",
    staticWindowSecs: 86400,
    processingActivityEnabled: false
  },
  enablePhase2Routes = true,
  enableTelegramRoutes = true,
  logger = console,
  clarifyRateLimiter = null,
  readinessCheck = (async () => ({
    ok: true,
    checks: {
      runtime: "ok"
    }
  })) as (() => Promise<{ ok: boolean; checks: Record<string, string> }>)
}: CreateServerOptions) {
  const log = buildLogger(logger);
  const rateLimiter = clarifyRateLimiter ?? createInMemoryRateLimiter();
  let isShuttingDown = false;
  const upcomingMarketTextScanLocks = new Map();

  function getMarketRepositoryForStage(marketStage: string = "active") {
    return marketStage === "upcoming" ? upcomingMarketCacheRepository : marketCacheRepository;
  }

  function getReviewerScanRepositoryForStage(marketStage: string = "active") {
    return marketStage === "upcoming" ? upcomingReviewerScanRepository : reviewerScanRepository;
  }

  async function findMarketByEventId(eventId: string | null | undefined, marketStage: string = "active") {
    if (!eventId) {
      return null;
    }

    return getMarketRepositoryForStage(marketStage)?.findByMarketId?.(eventId) ?? null;
  }

  async function findMarketForClarification(clarification: ClarificationRequest | null | undefined) {
    if (!clarification?.eventId) {
      return null;
    }

    const preferredStage = (clarification.marketStage as string | undefined) ?? "active";
    const preferredMarket = await findMarketByEventId(clarification.eventId, preferredStage);

    if (preferredMarket) {
      return preferredMarket;
    }

    if (preferredStage !== "upcoming") {
      return findMarketByEventId(clarification.eventId, "upcoming");
    }

    return findMarketByEventId(clarification.eventId, "active");
  }

  async function getAvailableCategoriesForStage(marketStage: string = "active") {
    const repository =
      marketStage === "upcoming" ? upcomingCategoryCatalogRepository : categoryCatalogRepository;
    return (await repository?.getCatalog?.(marketStage)) ?? { categories: [], updatedAt: null };
  }

  async function buildClarificationTimingForResponse({ clarification, market }: { clarification: ClarificationRequest; market: unknown }) {
    if (clarification?.timing && typeof clarification.timing === "object") {
      return clarification.timing;
    }

    if (!market) {
      return null;
    }

    return buildClarificationTiming({
      clarification,
      market,
      tradeActivityRepository,
      finalityConfig: clarificationFinalityConfig,
      now,
      fetchTrades: fetchTradesForSymbol
    });
  }

  async function buildPublicClarificationResponse(clarification: ClarificationRequest) {
    const market = clarification.eventId
      ? await findMarketForClarification(clarification)
      : null;
    const timing = await buildClarificationTimingForResponse({
      clarification,
      market
    });

    return {
      ...buildPublicClarificationPayload(clarification),
      ...(timing ? { timing } : {})
    };
  }

  async function waitForClarificationSettlement(clarificationId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let clarification =
      await clarificationRequestRepository.findByClarificationId(clarificationId);

    while (
      clarification &&
      ["queued", "processing"].includes(clarification.status) &&
      Date.now() < deadline
    ) {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        break;
      }

      await sleep(Math.min(250, remainingMs));
      clarification = await clarificationRequestRepository.findByClarificationId(clarificationId);
    }

    return clarification;
  }

  async function sendClarificationCreationResponse({
    response,
    clarification,
    waitOptions,
    job = null,
    headers = {}
  }: { response: ServerResponse; clarification: ClarificationRequest; waitOptions: { timeoutMs: number } | null; job?: Record<string, unknown> | null; headers?: Record<string, string> }) {
    if (waitOptions) {
      const settledClarification = await waitForClarificationSettlement(
        clarification.clarificationId!,
        waitOptions.timeoutMs
      );

      if (settledClarification && !["queued", "processing"].includes(settledClarification.status)) {
        sendJson(
          response,
          200,
          {
            ok: true,
            clarification: await buildPublicClarificationResponse(settledClarification)
          },
          headers
        );
        return;
      }
    }

    sendJson(
      response,
      202,
      {
        ok: true,
        clarificationId: clarification.clarificationId,
        status: "processing",
        ...(job ? { job: buildBackgroundJobPayload(job) } : {})
      },
      headers
    );
  }

  async function markJobProcessing(job: Record<string, unknown> & { jobId: string; kind: string; target: Record<string, unknown> }) {
    const processingTimestamp = now().toISOString();

    const updated = (await backgroundJobRepository?.updateByJobId?.(job.jobId, {
      status: "processing",
      updatedAt: processingTimestamp,
      attempts: ((job.attempts as number | undefined) ?? 0) + 1
    } as Partial<BackgroundJob>)) ?? {
      ...job,
      status: "processing",
      updatedAt: processingTimestamp,
      attempts: ((job.attempts as number | undefined) ?? 0) + 1
    };
    return updated as unknown as Record<string, unknown> & { kind: string; target: Record<string, unknown>; jobId: string; updatedAt: string };
  }

  async function executeClarificationPipelineJob(job: Record<string, unknown> & { target: Record<string, unknown>; jobId: string }) {
    await clarificationRequestRepository.updateByClarificationId(job.target.clarificationId as string, {
      status: "processing",
      updatedAt: job.updatedAt as string,
      errorMessage: null,
      retryable: false
    });

    try {
      const clarification = await clarificationRequestRepository.findByClarificationId(
        job.target.clarificationId as string
      );
      const artifact = await runAutomaticClarificationPipeline({
        clarification: clarification as ClarificationRequest,
        clarificationRequestRepository,
        artifactRepository,
        artifactPublisher,
        marketCacheRepository: getMarketRepositoryForStage(
          (clarification?.marketStage as string | undefined) ?? (job.target.marketStage as string | undefined) ?? "active"
        ),
        resolveMarketByClarification: findMarketForClarification,
        tradeActivityRepository,
        clarificationFinalityConfig,
        now,
        fetchTradesForSymbol,
        llmTraceability,
        llmRuntime
      });

      await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "completed",
        updatedAt: now().toISOString(),
        retryable: false,
        errorMessage: null,
        result: {
          clarificationId: job.target.clarificationId,
          artifactCid: (artifact as { artifact?: { cid?: string } } | null | undefined)?.artifact?.cid ?? null
        }
      });
    } catch (pipelineError: unknown) {
      const failedAt = now().toISOString();
      const pipelineErrorMessage = pipelineError instanceof Error ? pipelineError.message : String(pipelineError);

      console.error(
        `[clarification_pipeline] job ${job.jobId} failed for clarification ${job.target.clarificationId}:`,
        pipelineErrorMessage
      );

      await clarificationRequestRepository.updateByClarificationId(job.target.clarificationId as string, {
        status: "failed",
        updatedAt: failedAt,
        errorMessage: pipelineErrorMessage,
        retryable: true,
        llmOutput: null
      });

      await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "failed",
        updatedAt: failedAt,
        retryable: true,
        errorMessage: pipelineErrorMessage,
        result: null
      });
    }
  }

  async function executeReviewerScanJob(job: Record<string, unknown> & { target: Record<string, unknown>; jobId: string }) {
    try {
      const marketStage = (job.target.marketStage as string | undefined) ?? "active";
      const scan = await runReviewerMarketScan({
        jobId: job.jobId,
        eventId: job.target.eventId as string,
        marketCacheRepository: getMarketRepositoryForStage(marketStage),
        reviewerScanRepository: getReviewerScanRepositoryForStage(marketStage),
        now,
        llmRuntime,
        requireUpcomingOpenMarket: marketStage === "upcoming",
        dedupeByMarketText: marketStage === "upcoming",
        inFlightMarketTextScans:
          marketStage === "upcoming" ? upcomingMarketTextScanLocks : null
      }) as Record<string, unknown>;

      await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "completed",
        updatedAt: now().toISOString(),
        retryable: false,
        errorMessage: null,
        result: {
          scanId: scan.scanId
        }
      });
    } catch (scanError: unknown) {
      const scanErrorMessage = scanError instanceof Error ? scanError.message : String(scanError);

      console.error(
        `[reviewer_scan] job ${job.jobId} failed for event ${job.target.eventId}:`,
        scanErrorMessage
      );

      await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "failed",
        updatedAt: now().toISOString(),
        retryable: true,
        errorMessage: scanErrorMessage,
        result: null
      });
    }
  }

  async function executeBackgroundJob(job: Record<string, unknown> & { kind: string; target: Record<string, unknown>; jobId: string }) {
    if (job.kind === "clarification_pipeline") {
      await executeClarificationPipelineJob(job);
      return;
    }

    if (job.kind === "reviewer_scan") {
      await executeReviewerScanJob(job);
      return;
    }

    if (job.kind === "reviewer_prelaunch_scan") {
      await executeReviewerScanJob(job);
      return;
    }

    throw new Error(`Unsupported background job kind: ${job.kind}`);
  }

  async function startBackgroundJob(job: Record<string, unknown>) {
    const typedJob = job as Record<string, unknown> & { kind: string; target: Record<string, unknown>; jobId: string };
    const processingJob = await markJobProcessing(typedJob);
    void Promise.resolve().then(() => executeBackgroundJob(processingJob));
    return processingJob;
  }

  async function resumeRecoverableBackgroundJobs() {
    const recoverableJobs = (await backgroundJobRepository?.listRecoverable?.()) ?? [];

    for (const job of recoverableJobs) {
      await startBackgroundJob(job);
    }

    return recoverableJobs.length;
  }

  const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const requestContext = buildRequestContext(request);
    const startedAt = Date.now();
    const forwardedProto = request.headers["x-forwarded-proto"];
    const requestProtocol =
      typeof forwardedProto === "string" && forwardedProto.trim() !== ""
        ? forwardedProto.split(",")[0].trim()
        : "http";
    const requestHost =
      typeof request.headers.host === "string" && request.headers.host.trim() !== ""
        ? request.headers.host
        : "127.0.0.1";
    const requestUrl = new URL(request.url ?? "/", `${requestProtocol}://${requestHost}`);
    const waitOptions = parseBoundedWaitOptions(requestUrl);
    response.setHeader("x-request-id", requestContext.requestId);
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type, x-payment, x-reviewer-token, payment-signature");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    response.on("finish", () => {
      log.info("request.completed", {
        requestId: requestContext.requestId,
        method: request.method,
        path: requestUrl.pathname,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
        clientAddress: requestContext.clientAddress
      });
    });

    if (request.method === "GET" && requestUrl.pathname === "/health/live") {
      sendJson(response, 200, {
        ok: true
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/health/ready") {
      try {
        const readiness = await readinessCheck();
        sendJson(response, readiness.ok && !isShuttingDown ? 200 : 503, {
          ok: readiness.ok && !isShuttingDown,
          checks: {
            ...(readiness.checks ?? {}),
            shuttingDown: isShuttingDown ? "draining" : "ok"
          }
        });
      } catch (error: unknown) {
        log.error("readiness.failed", {
          requestId: requestContext.requestId,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        sendJson(response, 503, {
          ok: false,
          checks: {
            runtime: "error",
            shuttingDown: isShuttingDown ? "draining" : "ok"
          }
        });
      }

      return;
    }

    if (!enableTelegramRoutes && requestUrl.pathname.startsWith("/api/telegram/")) {
      sendNotFound(response);
      return;
    }

    if (
      !enablePhase2Routes &&
      (requestUrl.pathname.startsWith("/api/reviewer/") ||
        requestUrl.pathname.startsWith("/api/artifacts/"))
    ) {
      sendNotFound(response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/telegram/webhook") {
      try {
        assertTelegramWebhookSecret(request, telegramWebhookSecret);
        const update = await readJsonBody(request);
        const result = await createTelegramClarificationRequest({
          update,
          repository: clarificationRequestRepository,
          now,
          createRequestId
        });

        sendJson(response, 202, {
          ok: true,
          requestId: result.requestId,
          status: result.status
        });
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "INVALID_JSON",
              message: "Request body must be valid JSON."
            }
          });
          return;
        }

        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        log.error("clarify.request.failed", {
          requestId: requestContext.requestId,
          path: requestUrl.pathname,
          errorName: error instanceof Error ? error.name : "Error",
          errorMessage: error instanceof Error ? error.message : "Unknown error",
          errorStack: error instanceof Error ? (error.stack ?? null) : null
        });

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/clarify\/[^/]+$/.test(requestUrl.pathname)
    ) {
      try {
        const rateLimitResult = rateLimiter.check(
          `${requestContext.clientAddress}:${requestUrl.pathname}`
        );

        if (!rateLimitResult.allowed) {
          sendJson(
            response,
            429,
            {
              ok: false,
              error: {
                code: "RATE_LIMITED",
                message: "Too many clarification requests. Retry later."
              }
            },
            {
              "retry-after": String(rateLimitResult.retryAfterSeconds ?? 60)
            }
          );
          return;
        }

        const eventId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/clarify\/([^/]+)$/, "$1")
        );
        const body = await readJsonBody(request);
        const payload = parseClarificationRequestInput(body);
        const activeMarket = await findMarketByEventId(eventId, "active");
        const upcomingMarket = activeMarket ? null : await findMarketByEventId(eventId, "upcoming");
        const supportedMarket = activeMarket ?? upcomingMarket;
        const marketStage = upcomingMarket ? "upcoming" : "active";

        if (!supportedMarket) {
          throw Object.assign(
            new Error("Event id must match an active or upcoming synced market before a clarification can be created."),
            { statusCode: 404, code: "UNSUPPORTED_EVENT_ID" }
          );
        }

        const paymentCandidate = extractX402PaymentCandidate(request, body);

        if (!paymentCandidate) {
          const challengePayload = buildX402PaymentChallenge({
            eventId,
            requesterId: payload.requesterId,
            config: x402PaymentConfig,
            requestUrl
          }) as { paymentRequirements?: Record<string, unknown>[] };
          const paymentRequiredHeader = buildX402PaymentRequiredHeader(challengePayload);
          sendJson(response, 402, challengePayload, {
            "payment-required": Buffer.from(
              JSON.stringify(paymentRequiredHeader),
              "utf8"
            ).toString("base64")
          });
          return;
        }

        const verifiedPayment = await verifyX402Payment({
          paymentCandidate,
          config: x402PaymentConfig,
          now,
          requestContext: {
            eventId,
            requesterId: payload.requesterId
          },
          requestUrl
        }) as VerifiedPaymentResult;

        const existingClarification =
          await clarificationRequestRepository.findByPaymentProof(verifiedPayment.paymentProof);

        if (existingClarification) {
          if (waitOptions) {
            await sendClarificationCreationResponse({
              response,
              clarification: existingClarification,
              waitOptions
            });
          } else {
            sendJson(response, 200, {
              ok: true,
              clarificationId: existingClarification.clarificationId,
              status: existingClarification.status
            });
          }
          return;
        }

        const timestamp = now().toISOString();
        const initialTiming = await buildClarificationTiming({
          clarification: {
            eventId,
            status: "queued",
            llmOutput: null
          },
          market: supportedMarket,
          tradeActivityRepository,
          finalityConfig: clarificationFinalityConfig,
          now,
          fetchTrades: fetchTradesForSymbol
        });
        const clarificationPayload = {
          clarificationId: createClarificationId(),
          requestId: null as unknown as string,
          source: "paid_api",
          status: "queued",
          eventId,
          marketStage,
          question: payload.question,
          normalizedInput: {
            eventId,
            question: payload.question
          },
          requesterId: payload.requesterId || verifiedPayment.paymentPayer || null,
          paymentAmount: verifiedPayment.paymentAmount,
          paymentAsset: verifiedPayment.paymentAsset,
          paymentReference: verifiedPayment.paymentReference,
          paymentProof: verifiedPayment.paymentProof,
          paymentVerifiedAt: verifiedPayment.paymentVerifiedAt ?? timestamp,
          paymentRecipient: verifiedPayment.paymentRecipient ?? null,
          paymentMint: verifiedPayment.paymentMint ?? null,
          paymentCluster: verifiedPayment.paymentCluster ?? null,
          paymentTransactionSignature: verifiedPayment.paymentTransactionSignature ?? null,
          paymentVerificationSource: verifiedPayment.verificationSource ?? null,
          timing: initialTiming,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        const jobTimestamp = now().toISOString();
        const queuedJobPayload = {
          jobId: createBackgroundJobId(),
          kind: "clarification_pipeline",
          status: "queued",
          createdAt: jobTimestamp,
          updatedAt: jobTimestamp,
          attempts: 0,
          retryable: false,
          target: {
            clarificationId: clarificationPayload.clarificationId,
            eventId,
            marketStage
          },
          errorMessage: null,
          result: null
        };
        let clarification: ClarificationRequest | null = null;
        let queuedJob = null;

        if (phase1Coordinator) {
          const coordinatedResult = await phase1Coordinator.createPaidClarification({
            clarification: clarificationPayload,
            verifiedPayment: {
              ...verifiedPayment,
              createdAt: timestamp,
              updatedAt: timestamp
            } as VerifiedPayment,
            backgroundJob: queuedJobPayload as BackgroundJob
          });

          if (!coordinatedResult.created) {
            if (waitOptions) {
              await sendClarificationCreationResponse({
                response,
                clarification: coordinatedResult.clarification,
                waitOptions
              });
            } else {
              sendJson(response, 200, {
                ok: true,
                clarificationId: coordinatedResult.clarification.clarificationId,
                status: coordinatedResult.clarification.status
              });
            }
            return;
          }

          clarification = coordinatedResult.clarification;
          queuedJob = coordinatedResult.job;
        } else {
          const existingVerifiedPayment =
            (await verifiedPaymentRepository?.findByPaymentProof?.(verifiedPayment.paymentProof)) ??
            null;

          if (!existingVerifiedPayment) {
            await verifiedPaymentRepository?.create?.({
              ...verifiedPayment,
              createdAt: timestamp,
              updatedAt: timestamp
            } as VerifiedPayment);
          }

          clarification = await clarificationRequestRepository.create(clarificationPayload);
          await verifiedPaymentRepository?.updateByPaymentProof?.(verifiedPayment.paymentProof, {
            clarificationId: clarification?.clarificationId,
            updatedAt: timestamp
          });
          queuedJob = (await backgroundJobRepository?.create?.(queuedJobPayload)) ?? null;
        }

        const processingJob = queuedJob ? await startBackgroundJob(queuedJob) : null;

        await clarificationRequestRepository.updateByClarificationId(clarification!.clarificationId!, {
          status: "processing",
          updatedAt: jobTimestamp,
          errorMessage: null,
          retryable: false
        });

        if (!queuedJob) {
          const processingClarification =
            await clarificationRequestRepository.findByClarificationId(
              clarification!.clarificationId!
            );
          void Promise.resolve()
            .then(() =>
              runAutomaticClarificationPipeline({
                clarification: processingClarification as ClarificationRequest,
                clarificationRequestRepository,
                artifactRepository,
                artifactPublisher,
                marketCacheRepository: getMarketRepositoryForStage(
                  (processingClarification?.marketStage as string | undefined) ?? "active"
                ),
                resolveMarketByClarification: findMarketForClarification,
                tradeActivityRepository,
                clarificationFinalityConfig,
                now,
                fetchTradesForSymbol,
                llmTraceability,
                llmRuntime
              })
            )
            .catch(async (pipelineError: unknown) => {
              await clarificationRequestRepository.updateByClarificationId(
                clarification!.clarificationId!,
                {
                  status: "failed",
                  updatedAt: now().toISOString(),
                  errorMessage: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
                  retryable: true,
                  llmOutput: null
                }
              );
            });
        }

        await sendClarificationCreationResponse({
          response,
          clarification: clarification!,
          waitOptions,
          job: processingJob,
          headers: verifiedPayment.paymentResponseHeader
            ? {
                "payment-response": verifiedPayment.paymentResponseHeader
              }
            : {}
        });
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "INVALID_JSON",
              message: "Request body must be valid JSON."
            }
          });
          return;
        }

        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {})
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/reviewer/queue") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const markets = (await marketCacheRepository?.list?.()) ?? [];
        const clarifications = (await clarificationRequestRepository?.list?.()) ?? [];
        const queue: Record<string, unknown>[] = [];

        for (const market of markets) {
          const marketId = market.marketId as string;
          const latestScan =
            (await reviewerScanRepository?.findLatestByEventId?.(marketId)) ?? null;
          const eventClarifications = (clarifications as ClarificationRequest[]).filter(
            (clarification) => clarification.eventId === marketId
          );
          const latestClarification =
            eventClarifications
              .slice()
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
              .at(0) ?? null;
          const reviewWindow =
            (latestScan?.review_window as { time_to_end_bucket: string } | undefined) ??
            (buildAdaptiveReviewWindow({
              clarification: {
                llmOutput: {
                  ambiguity_score: 0
                }
              },
              market,
              now: now()
            }) as { time_to_end_bucket: string });
          const fundingProgress = buildQueueFundingProgress(
            latestClarification,
            eventClarifications
          );
          const voteStatus = (latestClarification?.reviewerWorkflowStatus ?? "not_started") as string;
          const queueStates = buildQueueStates({
            latestScan,
            fundingProgress,
            reviewWindow,
            voteStatus
          });

          queue.push({
            eventId: marketId,
            latestClarificationId: latestClarification?.clarificationId ?? null,
            marketTitle: market.title,
            endTime: market.closesAt,
            ambiguityScore: latestScan?.ambiguity_score ?? null,
            fundingProgress,
            reviewWindow,
            voteStatus,
            queueStates
          });
        }

        const filters = buildReviewerQueueFilters(queue as Array<{ queueStates: string[] }>);
        const activeFilter = requestUrl.searchParams.get("filter");
        const filteredQueue = REVIEWER_QUEUE_FILTERS.some(
          (filter) => filter.key === activeFilter
        )
          ? queue.filter((item) => (item.queueStates as string[]).includes(activeFilter as string))
          : queue;
        const availableCategories = await getAvailableCategoriesForStage("active");

        sendJson(response, 200, {
          ok: true,
          ...(activeFilter ? { activeFilter } : {}),
          filters,
          queue: filteredQueue,
          availableCategories: availableCategories.categories
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/reviewer/prelaunch/queue") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const markets = (await upcomingMarketCacheRepository?.list?.()) ?? [];
        const queue: Record<string, unknown>[] = [];
        const skipTermsUrls = await skipScanTermsRepository?.list?.() ?? [];
        const globalTermsUrls = new Set(skipTermsUrls);

        for (const market of markets) {
          const latestScan =
            (await upcomingReviewerScanRepository?.findLatestByEventId?.(market.marketId as string)) ?? null;
          queue.push(
            buildPrelaunchQueueItem({
              market,
              latestScan,
              now: now(),
              globalTermsUrls
            })
          );
        }

        const availableCategories = await getAvailableCategoriesForStage("upcoming");

        sendJson(response, 200, {
          ok: true,
          queue,
          availableCategories: availableCategories.categories,
          globalTermsUrls: skipTermsUrls
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "GET" &&
      /^\/api\/reviewer\/prelaunch\/markets\/[^/]+$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const eventId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/reviewer\/prelaunch\/markets\/([^/]+)$/, "$1")
        );
        const market = await upcomingMarketCacheRepository?.findByMarketId?.(eventId);

        if (!market) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "MARKET_NOT_FOUND",
              message: "Upcoming market was not found."
            }
          });
          return;
        }

        const latestScan =
          (await upcomingReviewerScanRepository?.findLatestByEventId?.(eventId)) ?? null;

        sendJson(response, 200, {
          ok: true,
          market: buildReviewerMarketPayload(market, eventId),
          latestScan: latestScan ? buildReviewerScanListItem(latestScan) : null
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/reviewer/scans") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const scans = ((await reviewerScanRepository?.list?.()) ?? [])
          .sort((left: Record<string, unknown>, right: Record<string, unknown>) => (right.createdAt as string).localeCompare(left.createdAt as string))
          .map(buildReviewerScanListItem);

        sendJson(response, 200, {
          ok: true,
          scans
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/reviewer\/scan\/[^/]+$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const eventId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/reviewer\/scan\/([^/]+)$/, "$1")
        );
        const timestamp = now().toISOString();
        const queuedJob =
          (await backgroundJobRepository?.create?.({
            jobId: createBackgroundJobId(),
            kind: "reviewer_scan",
            status: "queued",
            createdAt: timestamp,
            updatedAt: timestamp,
            attempts: 0,
            retryable: false,
            target: {
              eventId
            },
            errorMessage: null,
            result: null
          })) ?? {
            jobId: createBackgroundJobId(),
            kind: "reviewer_scan",
            status: "queued",
            createdAt: timestamp,
            updatedAt: timestamp,
            attempts: 0,
            retryable: false,
            target: {
              eventId
            },
            errorMessage: null,
            result: null
          };
        if (!backgroundJobRepository) {
        const scan = await runReviewerMarketScan({
          jobId: queuedJob.jobId,
          eventId,
          marketCacheRepository,
          reviewerScanRepository,
          now,
          llmRuntime
        });

          sendJson(response, 202, {
            ok: true,
            scan
          });
          return;
        }

        const processingJob = await startBackgroundJob(queuedJob);

        sendJson(response, 202, {
          ok: true,
          job: buildBackgroundJobPayload(processingJob)
        });
      } catch (error: unknown) {
        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/reviewer\/prelaunch\/scan\/[^/]+$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const eventId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/reviewer\/prelaunch\/scan\/([^/]+)$/, "$1")
        );
        const timestamp = now().toISOString();
        const queuedJob =
          (await backgroundJobRepository?.create?.({
            jobId: createBackgroundJobId(),
            kind: "reviewer_prelaunch_scan",
            status: "queued",
            createdAt: timestamp,
            updatedAt: timestamp,
            attempts: 0,
            retryable: false,
            target: {
              eventId,
              marketStage: "upcoming"
            },
            errorMessage: null,
            result: null
          })) ?? {
            jobId: createBackgroundJobId(),
            kind: "reviewer_prelaunch_scan",
            status: "queued",
            createdAt: timestamp,
            updatedAt: timestamp,
            attempts: 0,
            retryable: false,
            target: {
              eventId,
              marketStage: "upcoming"
            },
            errorMessage: null,
            result: null
          };

        if (!backgroundJobRepository) {
          const scan = await runReviewerMarketScan({
            jobId: queuedJob.jobId,
            eventId,
            marketCacheRepository: upcomingMarketCacheRepository,
            reviewerScanRepository: upcomingReviewerScanRepository,
            now,
            llmRuntime,
            requireUpcomingOpenMarket: true,
            dedupeByMarketText: true,
            inFlightMarketTextScans: upcomingMarketTextScanLocks
          });

          sendJson(response, 202, {
            ok: true,
            scan
          });
          return;
        }

        const processingJob = await startBackgroundJob(queuedJob);

        sendJson(response, 202, {
          ok: true,
          job: buildBackgroundJobPayload(processingJob)
        });
      } catch (error: unknown) {
        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/reviewer/scan-all") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const markets = (await marketCacheRepository?.list?.()) ?? [];
        const jobs: Record<string, unknown>[] = [];

        for (const market of markets) {
          const marketId = market.marketId as string;
          const timestamp = now().toISOString();
          const queuedJob =
            (await backgroundJobRepository?.create?.({
              jobId: createBackgroundJobId(),
              kind: "reviewer_scan",
              status: "queued",
              createdAt: timestamp,
              updatedAt: timestamp,
              attempts: 0,
              retryable: false,
              target: {
                eventId: marketId
              },
              errorMessage: null,
              result: null
            })) ?? null;

          if (queuedJob) {
            jobs.push(await startBackgroundJob(queuedJob));
          } else {
            jobs.push(
              (await runReviewerMarketScan({
                jobId: createBackgroundJobId(),
                eventId: marketId,
                marketCacheRepository,
                reviewerScanRepository,
                now,
                llmRuntime
              })) as Record<string, unknown>
            );
          }
        }

        sendJson(response, 202, {
          ok: true,
          ...(backgroundJobRepository
            ? { jobs: jobs.map(buildBackgroundJobPayload) }
            : { scans: jobs })
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/reviewer/prelaunch/skip-scan-terms") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const urls = await skipScanTermsRepository?.list?.() ?? [];
        sendJson(response, 200, { ok: true, urls });
      } catch (error: unknown) {
        sendJson(response, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
      }

      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/reviewer/prelaunch/skip-scan-terms") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const body = await readJsonBody(request);
        const url = typeof body?.url === "string" ? body.url.trim() : null;

        if (!url) {
          sendJson(response, 400, { ok: false, error: { code: "INVALID_URL", message: "A terms URL is required." } });
          return;
        }

        const urls = await skipScanTermsRepository?.add?.(url) ?? [];
        sendJson(response, 200, { ok: true, urls });
      } catch (error: unknown) {
        sendJson(response, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
      }

      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname === "/api/reviewer/prelaunch/skip-scan-terms") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const body = await readJsonBody(request);
        const url = typeof body?.url === "string" ? body.url.trim() : null;

        if (!url) {
          sendJson(response, 400, { ok: false, error: { code: "INVALID_URL", message: "A terms URL is required." } });
          return;
        }

        const urls = await skipScanTermsRepository?.remove?.(url) ?? [];
        sendJson(response, 200, { ok: true, urls });
      } catch (error: unknown) {
        sendJson(response, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
      }

      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/reviewer/prelaunch/scan-all") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const skipTermsUrlsForScan = new Set(await skipScanTermsRepository?.list?.() ?? []);
        const markets = ((await upcomingMarketCacheRepository?.list?.()) ?? []).filter((market: Record<string, unknown>) => {
          if (!isFutureUpcomingMarket(market, now())) return false;
          const termsLink = typeof market.termsLink === "string" ? market.termsLink : null;
          return termsLink === null || !skipTermsUrlsForScan.has(termsLink);
        });
        const jobs: Record<string, unknown>[] = [];

        for (const market of markets) {
          const marketId = market.marketId as string;
          const timestamp = now().toISOString();
          const queuedJob =
            (await backgroundJobRepository?.create?.({
              jobId: createBackgroundJobId(),
              kind: "reviewer_prelaunch_scan",
              status: "queued",
              createdAt: timestamp,
              updatedAt: timestamp,
              attempts: 0,
              retryable: false,
              target: {
                eventId: marketId,
                marketStage: "upcoming"
              },
              errorMessage: null,
              result: null
            })) ?? null;

          if (queuedJob) {
            jobs.push(await startBackgroundJob(queuedJob));
          } else {
            jobs.push(
              (await runReviewerMarketScan({
                jobId: createBackgroundJobId(),
                eventId: marketId,
                marketCacheRepository: upcomingMarketCacheRepository,
                reviewerScanRepository: upcomingReviewerScanRepository,
                now,
                llmRuntime,
                requireUpcomingOpenMarket: true,
                dedupeByMarketText: true,
                inFlightMarketTextScans: upcomingMarketTextScanLocks
              })) as Record<string, unknown>
            );
          }
        }

        sendJson(response, 202, {
          ok: true,
          ...(backgroundJobRepository
            ? { jobs: jobs.map(buildBackgroundJobPayload) }
            : { scans: jobs })
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/reviewer\/jobs\/[^/]+\/retry$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const jobId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/reviewer\/jobs\/([^/]+)\/retry$/, "$1")
        );
        const job = await backgroundJobRepository?.findByJobId?.(jobId);

        if (!job) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "JOB_NOT_FOUND",
              message: "Background job was not found."
            }
          });
          return;
        }

        if (job.status !== "failed" || !job.retryable) {
          sendJson(response, 409, {
            ok: false,
            error: {
              code: "JOB_NOT_RETRYABLE",
              message: "Only failed retryable jobs can be retried."
            }
          });
          return;
        }

        const processingJob = await startBackgroundJob(job);

        sendJson(response, 202, {
          ok: true,
          job: buildBackgroundJobPayload(processingJob)
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/reviewer\/refresh-market\/[^/]+$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const eventId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/reviewer\/refresh-market\/([^/]+)$/, "$1")
        );
        const cachedMarket = await marketCacheRepository?.findByMarketId?.(eventId);
        const reviewerRefreshSource =
          fetchReviewerMarketSource ??
          (async (_requestedEventId: string) => {
            if (!cachedMarket?.ticker) {
              throw Object.assign(new Error("Cached market does not include a Gemini ticker."), {
                statusCode: 503,
                code: "MARKET_REFRESH_UNAVAILABLE"
              });
            }

            return fetchPredictionMarketEventByTicker(cachedMarket.ticker as string) as Promise<Record<string, unknown> | null>;
          });
        const market = await refreshReviewerMarketData({
          eventId,
          marketCacheRepository,
          fetchReviewerMarketSource: reviewerRefreshSource,
          now
        });

        sendJson(response, 200, {
          ok: true,
          market
        });
      } catch (error: unknown) {
        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "GET" &&
      /^\/api\/clarifications\/[^/]+$/.test(requestUrl.pathname)
    ) {
      try {
        const clarificationId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/clarifications\/([^/]+)$/, "$1")
        );
        const clarification =
          await clarificationRequestRepository.findByClarificationId(clarificationId);

        if (!clarification) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_FOUND",
              message: "Clarification not found."
            }
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          clarification: await buildPublicClarificationResponse(clarification)
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/reviewer\/clarifications\/[^/]+\/awaiting-panel-vote$/.test(
        requestUrl.pathname
      )
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const clarificationId = decodeURIComponent(
          requestUrl.pathname.replace(
            /^\/api\/reviewer\/clarifications\/([^/]+)\/awaiting-panel-vote$/,
            "$1"
          )
        );
        const clarification =
          await clarificationRequestRepository.findByClarificationId(clarificationId);

        if (!clarification) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_FOUND",
              message: "Clarification not found."
            }
          });
          return;
        }

        if (clarification.status !== "completed") {
          sendJson(response, 409, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_READY",
              message: "Only completed clarifications can move to awaiting panel vote."
            }
          });
          return;
        }

        const payload = parseReviewerWorkflowPayload(await readJsonBody(request));
        const updatedAt = now().toISOString();
        const reviewerActions = [
          ...(Array.isArray(clarification.reviewerActions) ? clarification.reviewerActions : []),
          {
            type: "marked_awaiting_panel_vote",
            actor: payload.reviewerId,
            timestamp: updatedAt,
            previousReviewerWorkflowStatus:
              clarification.reviewerWorkflowStatus ?? "not_started"
          }
        ];
        const updatedClarification =
          await clarificationRequestRepository.updateByClarificationId(clarificationId, {
            reviewerWorkflowStatus: "awaiting_panel_vote",
            reviewerActions,
            updatedAt
          });

        sendJson(response, 200, {
          ok: true,
          clarification: {
            clarificationId: updatedClarification!.clarificationId,
            reviewerWorkflowStatus: updatedClarification!.reviewerWorkflowStatus,
            vote: buildReviewerVotePayload(updatedClarification!)
          }
        });
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "INVALID_JSON",
              message: "Request body must be valid JSON."
            }
          });
          return;
        }

        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/reviewer\/clarifications\/[^/]+\/finalize$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const clarificationId = decodeURIComponent(
          requestUrl.pathname.replace(
            /^\/api\/reviewer\/clarifications\/([^/]+)\/finalize$/,
            "$1"
          )
        );
        const clarification =
          await clarificationRequestRepository.findByClarificationId(clarificationId);

        if (!clarification) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_FOUND",
              message: "Clarification not found."
            }
          });
          return;
        }

        if (clarification.status !== "completed") {
          sendJson(response, 409, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_READY",
              message: "Only completed clarifications can be finalized off-chain."
            }
          });
          return;
        }

        const payload = parseReviewerFinalizationPayload(await readJsonBody(request));
        const finalizedAt = now().toISOString();
        const reviewerActions = [
          ...(Array.isArray(clarification.reviewerActions) ? clarification.reviewerActions : []),
          {
            type: "finalized",
            actor: payload.reviewerId,
            timestamp: finalizedAt,
            previousReviewerWorkflowStatus:
              clarification.reviewerWorkflowStatus ?? "not_started",
            finalEditedText: payload.finalEditedText,
            finalNote: payload.finalNote
          }
        ];
        const finalizedClarification =
          await clarificationRequestRepository.updateByClarificationId(clarificationId, {
            reviewerWorkflowStatus: "finalized",
            finalEditedText: payload.finalEditedText,
            finalNote: payload.finalNote,
            finalizedAt,
            finalizedBy: payload.reviewerId,
            reviewerActions,
            updatedAt: finalizedAt
          });

        sendJson(response, 200, {
          ok: true,
          clarification: {
            clarificationId: finalizedClarification!.clarificationId,
            reviewerWorkflowStatus: finalizedClarification!.reviewerWorkflowStatus,
            finalization: {
              finalEditedText: finalizedClarification!.finalEditedText,
              finalNote: finalizedClarification!.finalNote,
              finalizedAt: finalizedClarification!.finalizedAt,
              finalizedBy: finalizedClarification!.finalizedBy
            }
          }
        });
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "INVALID_JSON",
              message: "Request body must be valid JSON."
            }
          });
          return;
        }

        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "GET" &&
      /^\/api\/reviewer\/clarifications\/[^/]+\/funding$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const clarificationId = decodeURIComponent(
          requestUrl.pathname.replace(
            /^\/api\/reviewer\/clarifications\/([^/]+)\/funding$/,
            "$1"
          )
        );
        const clarification =
          await clarificationRequestRepository.findByClarificationId(clarificationId);

        if (!clarification) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_FOUND",
              message: "Clarification not found."
            }
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          funding: buildStoredFundingDetails(clarification)
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/reviewer\/clarifications\/[^/]+\/funding\/contributions$/.test(
        requestUrl.pathname
      )
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const clarificationId = decodeURIComponent(
          requestUrl.pathname.replace(
            /^\/api\/reviewer\/clarifications\/([^/]+)\/funding\/contributions$/,
            "$1"
          )
        );
        const clarification =
          await clarificationRequestRepository.findByClarificationId(clarificationId);

        if (!clarification) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_FOUND",
              message: "Clarification not found."
            }
          });
          return;
        }

        const contribution = parseReviewerFundingContributionPayload(
          await readJsonBody(request)
        );
        const updatedAt = now().toISOString();
        const existingFunding = buildStoredFundingDetails(clarification);
        const existingContribution =
          contribution.reference === null
            ? null
            : existingFunding.history.find(
                (entry: FundingHistoryEntry) => entry.reference === contribution.reference
              ) ?? null;

        if (existingContribution) {
          sendJson(response, 200, {
            ok: true,
            funding: existingFunding
          });
          return;
        }

        const funding = buildFundingDetailsFromHistory(
          [
            {
              ...contribution,
              timestamp: updatedAt
            },
            ...existingFunding.history
          ],
          existingFunding.targetAmount
        );
        const updatedClarification =
          await clarificationRequestRepository.updateByClarificationId(clarificationId, {
            funding,
            updatedAt
          });

        sendJson(response, 201, {
          ok: true,
          funding: updatedClarification!.funding
        });
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "INVALID_JSON",
              message: "Request body must be valid JSON."
            }
          });
          return;
        }

        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "GET" &&
      /^\/api\/reviewer\/clarifications\/[^/]+\/audit$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const clarificationId = decodeURIComponent(
          requestUrl.pathname.replace(
            /^\/api\/reviewer\/clarifications\/([^/]+)\/audit$/,
            "$1"
          )
        );
        const clarification =
          await clarificationRequestRepository.findByClarificationId(clarificationId);

        if (!clarification) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_FOUND",
              message: "Clarification not found."
            }
          });
          return;
        }

        const artifact = clarification.artifactCid
          ? await artifactRepository?.findByCid?.(clarification.artifactCid as string)
          : null;

        sendJson(response, 200, {
          ok: true,
          audit: buildClarificationAuditPayload({
            clarification,
            artifact
          })
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "GET" &&
      /^\/api\/reviewer\/clarifications\/[^/]+$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const clarificationId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/reviewer\/clarifications\/([^/]+)$/, "$1")
        );
        const clarification =
          await clarificationRequestRepository.findByClarificationId(clarificationId);

        if (!clarification) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "CLARIFICATION_NOT_FOUND",
              message: "Clarification not found."
            }
          });
          return;
        }

        const market = clarification.eventId
          ? await findMarketForClarification(clarification)
          : null;
        const adaptiveReviewWindow = buildAdaptiveReviewWindow({
          clarification,
          market,
          now: now()
        });
        const timing = await buildClarificationTimingForResponse({
          clarification,
          market
        });
        const relatedClarifications = clarification.eventId
          ? await clarificationRequestRepository.findByEventId(clarification.eventId)
          : [];

        sendJson(response, 200, {
          ok: true,
          clarification: buildReviewerClarificationPayload({
            clarification: timing ? { ...clarification, timing } : clarification,
            adaptiveReviewWindow,
            market,
            relatedClarifications
          })
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "GET" &&
      /^\/api\/artifacts\/[^/]+$/.test(requestUrl.pathname)
    ) {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const cid = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/artifacts\/([^/]+)$/, "$1")
        );
        const artifact = await artifactRepository?.findByCid?.(cid);

        if (!artifact) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "ARTIFACT_NOT_FOUND",
              message: "Artifact not found."
            }
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          artifact
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/telegram/requests") {
      try {
        const telegramChatId = requestUrl.searchParams.get("chat_id");
        const telegramUserId = requestUrl.searchParams.get("user_id");

        if (!telegramChatId && !telegramUserId) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "MISSING_TELEGRAM_IDENTIFIERS",
              message: "Provide chat_id, user_id, or both to look up Telegram requests."
            }
          });
          return;
        }

        const requests = await clarificationRequestRepository.findByTelegramIdentifiers({
          telegramChatId,
          telegramUserId
        });

        sendJson(response, 200, {
          ok: true,
          requests: (requests as ClarificationRequest[]).map((storedRequest) => ({
            requestId: storedRequest.requestId,
            status: storedRequest.status,
            marketId: storedRequest.marketId,
            question: storedRequest.question,
            telegramChatId: storedRequest.telegramChatId,
            telegramUserId: storedRequest.telegramUserId,
            clarificationId: storedRequest.clarificationId ?? null,
            summary: storedRequest.summary ?? null,
            errorMessage: storedRequest.errorMessage ?? null,
            createdAt: storedRequest.createdAt,
            updatedAt: storedRequest.updatedAt ?? storedRequest.createdAt
          }))
        });
      } catch (error: unknown) {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/telegram\/requests\/[^/]+\/status$/.test(requestUrl.pathname)
    ) {
      try {
        const requestId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/telegram\/requests\/([^/]+)\/status$/, "$1")
        );
        const updates = parseTelegramStatusUpdate(await readJsonBody(request));
        const storedRequest = await clarificationRequestRepository.updateStatus(requestId, {
          ...updates,
          updatedAt: now().toISOString()
        });

        if (!storedRequest) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "REQUEST_NOT_FOUND",
              message: "Clarification request was not found."
            }
          });
          return;
        }

        const delivery = buildTelegramDeliveryPayload(storedRequest);
        let deliveryResult: Record<string, unknown> = {
          attempted: false,
          sent: false
        };

        if (telegramBotToken) {
          const telegramResponse = await sendTelegramMessage({
            botToken: telegramBotToken,
            chatId: delivery.chatId,
            text: delivery.text,
            apiBaseUrl: telegramBotApiBaseUrl
          }) as { messageId?: unknown };

          deliveryResult = {
            attempted: true,
            sent: true,
            messageId: telegramResponse.messageId
          };
        }

        sendJson(response, 200, {
          ok: true,
          requestId: storedRequest.requestId,
          status: storedRequest.status,
          delivery,
          deliveryResult
        });
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "INVALID_JSON",
              message: "Request body must be valid JSON."
            }
          });
          return;
        }

        if (isHttpError(error)) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        sendJson(response, 500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred."
          }
        });
      }

      return;
    }

    sendNotFound(response);
  });

  const appServer = server as AppServer;
  appServer.resumeRecoverableBackgroundJobs = resumeRecoverableBackgroundJobs;
  appServer.markShuttingDown = () => {
    isShuttingDown = true;
  };

  return appServer;
}
