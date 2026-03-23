import http from "node:http";
import { randomUUID } from "node:crypto";

import {
  fetchPredictionMarketEventByTicker,
  fetchTradesForSymbol as fetchDefaultTradesForSymbol
} from "./gemini-markets-source.js";
import { runAutomaticClarificationPipeline as runDefaultAutomaticClarificationPipeline } from "./automatic-llm-pipeline.js";
import { buildClarificationTiming } from "./clarification-timing.js";
import { refreshReviewerMarketData } from "./reviewer-refresh-market.js";
import { createTelegramClarificationRequest } from "./telegram-request-flow.js";
import {
  assertTelegramWebhookSecret,
  sendTelegramMessage as sendDefaultTelegramMessage
} from "./telegram-bot-client.js";
import {
  buildTelegramDeliveryPayload,
  parseTelegramStatusUpdate
} from "./telegram-status-delivery.js";
import { buildAdaptiveReviewWindow } from "./review-window-policy.js";
import { createReviewerMarketScan } from "./reviewer-scan-service.js";
import { parseClarificationRequestInput } from "./x402-paid-clarification.js";
import { buildX402PaymentRequiredPayload } from "./x402-payment-challenge.js";
import { buildX402PaymentRequiredHeader } from "./x402-payment-challenge.js";
import { loadX402PaymentConfig } from "./x402-payment-config.js";
import {
  extractX402PaymentCandidate,
  verifyClarificationPayment as verifyDefaultClarificationPayment
} from "./x402-payment-verifier.js";

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendNotFound(response) {
  sendJson(response, 404, {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found."
    }
  });
}

function buildLogger(logger = console) {
  return {
    info(message, fields = {}) {
      (logger.info ?? logger.log).call(logger, JSON.stringify({ level: "info", message, ...fields }));
    },
    warn(message, fields = {}) {
      (logger.warn ?? logger.log).call(logger, JSON.stringify({ level: "warn", message, ...fields }));
    },
    error(message, fields = {}) {
      (logger.error ?? logger.log).call(logger, JSON.stringify({ level: "error", message, ...fields }));
    }
  };
}

function buildRequestContext(request) {
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
} = {}) {
  const buckets = new Map();

  return {
    check(key, now = Date.now()) {
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

function hasReviewerAccess(request, reviewerAuthToken) {
  if (!reviewerAuthToken) {
    return false;
  }

  return request.headers["x-reviewer-token"] === reviewerAuthToken;
}

function sendReviewerAuthRequired(response) {
  sendJson(response, 401, {
    ok: false,
    error: {
      code: "REVIEWER_AUTH_REQUIRED",
      message: "Reviewer authentication is required for this route."
    }
  });
}

function buildPublicClarificationPayload(clarification) {
  const payload = {
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

function parseBoundedWaitOptions(requestUrl) {
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatWorkflowLabel(state) {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeFundingHistory(history = []) {
  return history
    .filter(
      (entry) =>
        entry &&
        typeof entry.contributor === "string" &&
        entry.contributor.trim() !== "" &&
        typeof entry.amount === "string" &&
        entry.amount !== "" &&
        typeof entry.timestamp === "string" &&
        entry.timestamp !== ""
    )
    .map((entry) => ({
      contributor: entry.contributor,
      amount: Number.parseFloat(entry.amount).toFixed(2),
      timestamp: entry.timestamp,
      reference: entry.reference ?? null
    }))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function buildFundingDetailsFromHistory(history = [], targetAmount = "1.00") {
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
    .reduce((total, entry) => total + Number.parseFloat(entry.amount), 0)
    .toFixed(2);
  const contributorCount = new Set(
    normalizedHistory.map((entry) => entry.contributor)
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

function buildFundingDetailsFromClarifications(clarifications = []) {
  const fundingProgress = buildFundingProgress(clarifications);
  const history = clarifications
    .filter(
      (clarification) =>
        typeof clarification.paymentAmount === "string" && clarification.paymentAmount !== ""
    )
    .map((clarification) => ({
      contributor: clarification.requesterId ?? clarification.paymentReference ?? "unknown",
      amount: clarification.paymentAmount,
      timestamp: clarification.paymentVerifiedAt ?? clarification.createdAt,
      reference: clarification.paymentReference ?? null
    }))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  return {
    ...fundingProgress,
    history
  };
}

function buildFundingDetails(clarification, relatedClarifications = []) {
  if (clarification?.funding && Array.isArray(clarification.funding.history)) {
    return buildFundingDetailsFromHistory(
      clarification.funding.history,
      clarification.funding.targetAmount ?? "1.00"
    );
  }

  return buildFundingDetailsFromClarifications(relatedClarifications);
}

function buildStoredFundingDetails(clarification) {
  if (clarification?.funding && Array.isArray(clarification.funding.history)) {
    return buildFundingDetailsFromHistory(
      clarification.funding.history,
      clarification.funding.targetAmount ?? "1.00"
    );
  }

  return buildFundingDetailsFromHistory([]);
}

function buildReviewerVotePayload(clarification) {
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
}) {
  const clarificationPayload = {
    ...buildPublicClarificationPayload(clarification),
    llmOutput: clarification.llmOutput ?? null,
    llmTrace: clarification.llmTrace ?? null,
    market: buildReviewerMarketPayload(market, clarification.eventId),
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

function buildReviewerMarketPayload(market, fallbackMarketId = null) {
  const payload = {
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

function buildReviewerActionDetails(action) {
  return Object.fromEntries(
    Object.entries(action).filter(([key]) => !["type", "actor", "timestamp"].includes(key))
  );
}

function buildClarificationAuditTimeline({ clarification, artifact }) {
  const timeline = [];

  for (const entry of Array.isArray(clarification.statusHistory)
    ? clarification.statusHistory
    : []) {
    timeline.push({
      type: "status_changed",
      timestamp: entry.timestamp,
      status: entry.status
    });
  }

  if (clarification.llmTrace?.requestedAt) {
    timeline.push({
      type: "llm_requested",
      timestamp: clarification.llmTrace.requestedAt,
      promptTemplateVersion: clarification.llmTrace.promptTemplateVersion ?? null,
      modelId: clarification.llmTrace.modelId ?? null,
      processingVersion: clarification.llmTrace.processingVersion ?? null
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

  const priority = {
    status_changed: 1,
    llm_requested: 2,
    artifact_published: 3,
    reviewer_action: 4,
    funding_contribution_recorded: 5
  };

  return timeline.sort((left, right) => {
    const timestampComparison = left.timestamp.localeCompare(right.timestamp);

    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return (priority[left.type] ?? 99) - (priority[right.type] ?? 99);
  });
}

function buildClarificationAuditPayload({ clarification, artifact }) {
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
  { key: "funded", label: "Funded" },
  { key: "near_expiry", label: "Near Expiry" },
  { key: "awaiting_panel_vote", label: "Awaiting Panel Vote" },
  { key: "finalized", label: "Finalized" }
];

function buildFundingProgress(clarifications = []) {
  const fundedClarifications = clarifications.filter(
    (clarification) =>
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
    .reduce((total, clarification) => {
      const parsedAmount = Number.parseFloat(clarification.paymentAmount);
      return total + (Number.isFinite(parsedAmount) ? parsedAmount : 0);
    }, 0)
    .toFixed(2);
  const contributorCount = new Set(
    fundedClarifications.map(
      (clarification) => clarification.requesterId ?? clarification.paymentReference
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

function buildQueueFundingProgress(latestClarification, clarifications = []) {
  return latestClarification?.funding
    ? buildFundingDetails(latestClarification, clarifications)
    : buildFundingProgress(clarifications);
}

function parseReviewerFundingContributionPayload(payload) {
  const contributor = String(payload?.contributor ?? "").trim();
  const amount = String(payload?.amount ?? "").trim();
  const reference =
    payload?.reference === undefined || payload?.reference === null
      ? null
      : String(payload.reference).trim() || null;

  if (!contributor) {
    const error = new Error("Contributor is required.");
    error.statusCode = 400;
    error.code = "INVALID_FUNDING_CONTRIBUTOR";
    throw error;
  }

  const parsedAmount = Number.parseFloat(amount);

  if (!amount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    const error = new Error("Funding amount must be a positive decimal string.");
    error.statusCode = 400;
    error.code = "INVALID_FUNDING_AMOUNT";
    throw error;
  }

  return {
    contributor,
    amount: parsedAmount.toFixed(2),
    reference
  };
}

function buildQueueStates({ latestScan, fundingProgress, reviewWindow, voteStatus }) {
  const queueStates = [];

  if (!latestScan) {
    queueStates.push("needs_scan");
  }

  if ((latestScan?.ambiguity_score ?? 0) >= 0.7) {
    queueStates.push("high_ambiguity");
  }

  if (fundingProgress.fundingState !== "unfunded") {
    queueStates.push("funded");
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

function buildReviewerQueueFilters(queue) {
  return REVIEWER_QUEUE_FILTERS.map((filter) => ({
    ...filter,
    count: queue.filter((item) => item.queueStates.includes(filter.key)).length
  }));
}

function buildReviewerScanListItem(scan) {
  return {
    scanId: scan.scanId,
    eventId: scan.eventId,
    createdAt: scan.createdAt,
    ambiguityScore: scan.ambiguity_score,
    recommendation: scan.recommendation,
    reviewWindow: scan.review_window
  };
}

function buildPrelaunchQueueItem({ market, latestScan, now }) {
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

  return {
    eventId: market.marketId,
    marketTitle: market.title,
    ticker: market.ticker ?? null,
    category: market.category ?? null,
    status: market.status ?? null,
    startsAt: market.effectiveDate ?? null,
    endTime: market.closesAt,
    ambiguityScore: latestScan?.ambiguity_score ?? null,
    needsScan: latestScan === null,
    latestScanId: latestScan?.scanId ?? null,
    reviewWindow,
    contracts: Array.isArray(market.contracts) ? market.contracts : []
  };
}

function isFutureUpcomingMarket(market, referenceNow) {
  const closesAt = market?.closesAt ?? market?.endTime ?? market?.expiryDate ?? null;

  if (typeof closesAt !== "string" || closesAt.trim() === "") {
    return false;
  }

  const closesAtMs = Date.parse(closesAt);
  return Number.isFinite(closesAtMs) && closesAtMs > referenceNow.getTime();
}

function parseReviewerFinalizationPayload(payload) {
  const finalEditedText = String(payload?.finalEditedText ?? "").trim();
  const finalNote = String(payload?.finalNote ?? "").trim();
  const reviewerId = String(payload?.reviewerId ?? "system").trim();

  if (!finalEditedText) {
    const error = new Error("Final edited text is required.");
    error.statusCode = 400;
    error.code = "INVALID_FINAL_EDITED_TEXT";
    throw error;
  }

  if (!finalNote) {
    const error = new Error("Final note is required.");
    error.statusCode = 400;
    error.code = "INVALID_FINAL_NOTE";
    throw error;
  }

  if (!reviewerId) {
    const error = new Error("Reviewer identity is required.");
    error.statusCode = 400;
    error.code = "INVALID_REVIEWER_ID";
    throw error;
  }

  return {
    finalEditedText,
    finalNote,
    reviewerId
  };
}

function parseReviewerWorkflowPayload(payload) {
  const reviewerId = String(payload?.reviewerId ?? "system").trim();

  if (!reviewerId) {
    const error = new Error("Reviewer identity is required.");
    error.statusCode = 400;
    error.code = "INVALID_REVIEWER_ID";
    throw error;
  }

  return {
    reviewerId
  };
}

function buildBackgroundJobPayload(job) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    retryable: job.retryable,
    target: job.target
  };
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");

  if (!body) {
    return {};
  }

  return JSON.parse(body);
}

export function createServer({
  clarificationRequestRepository,
  artifactRepository,
  artifactPublisher = null,
  backgroundJobRepository,
  reviewerScanRepository,
  categoryCatalogRepository,
  marketCacheRepository,
  upcomingMarketCacheRepository,
  upcomingReviewerScanRepository,
  upcomingCategoryCatalogRepository,
  tradeActivityRepository,
  now,
  createRequestId,
  createClarificationId,
  createBackgroundJobId = () => randomUUID(),
  llmTraceability,
  llmRuntime,
  reviewerAuthToken,
  telegramWebhookSecret,
  telegramBotToken,
  telegramBotApiBaseUrl,
  x402PaymentConfig = loadX402PaymentConfig(),
  verifiedPaymentRepository,
  phase1Coordinator = null,
  verifyX402Payment = verifyDefaultClarificationPayment,
  buildX402PaymentChallenge = buildX402PaymentRequiredPayload,
  fetchReviewerMarketSource,
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
  readinessCheck = async () => ({
    ok: true,
    checks: {
      runtime: "ok"
    }
  })
}) {
  const log = buildLogger(logger);
  const rateLimiter = clarifyRateLimiter ?? createInMemoryRateLimiter();
  let isShuttingDown = false;
  const upcomingMarketTextScanLocks = new Map();

  function getMarketRepositoryForStage(marketStage = "active") {
    return marketStage === "upcoming" ? upcomingMarketCacheRepository : marketCacheRepository;
  }

  function getReviewerScanRepositoryForStage(marketStage = "active") {
    return marketStage === "upcoming" ? upcomingReviewerScanRepository : reviewerScanRepository;
  }

  async function getAvailableCategoriesForStage(marketStage = "active") {
    const repository =
      marketStage === "upcoming" ? upcomingCategoryCatalogRepository : categoryCatalogRepository;
    return (await repository?.getCatalog?.(marketStage)) ?? { categories: [], updatedAt: null };
  }

  async function buildClarificationTimingForResponse({ clarification, market }) {
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

  async function buildPublicClarificationResponse(clarification) {
    const market = clarification.eventId
      ? await marketCacheRepository?.findByMarketId(clarification.eventId)
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

  async function waitForClarificationSettlement(clarificationId, timeoutMs) {
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
  }) {
    if (waitOptions) {
      const settledClarification = await waitForClarificationSettlement(
        clarification.clarificationId,
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

  async function markJobProcessing(job) {
    const processingTimestamp = now().toISOString();

    return (
      (await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "processing",
        updatedAt: processingTimestamp,
        attempts: (job.attempts ?? 0) + 1
      })) ?? {
        ...job,
        status: "processing",
        updatedAt: processingTimestamp,
        attempts: (job.attempts ?? 0) + 1
      }
    );
  }

  async function executeClarificationPipelineJob(job) {
    await clarificationRequestRepository.updateByClarificationId(job.target.clarificationId, {
      status: "processing",
      updatedAt: job.updatedAt,
      errorMessage: null,
      retryable: false
    });

    try {
      const clarification = await clarificationRequestRepository.findByClarificationId(
        job.target.clarificationId
      );
      const artifact = await runAutomaticClarificationPipeline({
        clarification,
        clarificationRequestRepository,
        artifactRepository,
        artifactPublisher,
        marketCacheRepository,
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
          artifactCid: artifact?.artifact?.cid ?? null
        }
      });
    } catch (pipelineError) {
      const failedAt = now().toISOString();

      await clarificationRequestRepository.updateByClarificationId(job.target.clarificationId, {
        status: "failed",
        updatedAt: failedAt,
        errorMessage: pipelineError.message,
        retryable: true,
        llmOutput: null
      });

      await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "failed",
        updatedAt: failedAt,
        retryable: true,
        errorMessage: pipelineError.message,
        result: null
      });
    }
  }

  async function executeReviewerScanJob(job) {
    try {
      const marketStage = job.target.marketStage ?? "active";
      const scan = await runReviewerMarketScan({
        jobId: job.jobId,
        eventId: job.target.eventId,
        marketCacheRepository: getMarketRepositoryForStage(marketStage),
        reviewerScanRepository: getReviewerScanRepositoryForStage(marketStage),
        now,
        llmRuntime,
        requireUpcomingOpenMarket: marketStage === "upcoming",
        dedupeByMarketText: marketStage === "upcoming",
        inFlightMarketTextScans:
          marketStage === "upcoming" ? upcomingMarketTextScanLocks : null
      });

      await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "completed",
        updatedAt: now().toISOString(),
        retryable: false,
        errorMessage: null,
        result: {
          scanId: scan.scanId
        }
      });
    } catch (scanError) {
      await backgroundJobRepository?.updateByJobId?.(job.jobId, {
        status: "failed",
        updatedAt: now().toISOString(),
        retryable: true,
        errorMessage: scanError.message,
        result: null
      });
    }
  }

  async function executeBackgroundJob(job) {
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

  async function startBackgroundJob(job) {
    const processingJob = await markJobProcessing(job);
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

  const server = http.createServer(async (request, response) => {
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
    const requestUrl = new URL(request.url, `${requestProtocol}://${requestHost}`);
    const waitOptions = parseBoundedWaitOptions(requestUrl);
    response.setHeader("x-request-id", requestContext.requestId);

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
      } catch (error) {
        log.error("readiness.failed", {
          requestId: requestContext.requestId,
          errorMessage: error.message
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
      } catch (error) {
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

        if (error.statusCode) {
          sendJson(response, error.statusCode, {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
          return;
        }

        logger.error("clarify.request.failed", {
          requestId: requestContext.requestId,
          path: requestUrl.pathname,
          errorName: error?.name ?? "Error",
          errorMessage: error?.message ?? "Unknown error",
          errorStack: error?.stack ?? null
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
        const supportedMarket = await marketCacheRepository?.findByMarketId(eventId);

        if (!supportedMarket) {
          const error = new Error(
            "Event id must match an active synced market before a clarification can be created."
          );
          error.statusCode = 404;
          error.code = "UNSUPPORTED_EVENT_ID";
          throw error;
        }

        const paymentCandidate = extractX402PaymentCandidate(request, body);

        if (!paymentCandidate) {
          const challengePayload = buildX402PaymentChallenge({
            eventId,
            requesterId: payload.requesterId,
            config: x402PaymentConfig,
            requestUrl
          });
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
          requestUrl,
          verifiedPaymentRepository
        });

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
          requestId: null,
          source: "paid_api",
          status: "queued",
          eventId,
          question: payload.question,
          normalizedInput: {
            eventId,
            question: payload.question
          },
          requesterId: payload.requesterId,
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
            eventId
          },
          errorMessage: null,
          result: null
        };
        let clarification = null;
        let queuedJob = null;

        if (phase1Coordinator) {
          const coordinatedResult = await phase1Coordinator.createPaidClarification({
            clarification: clarificationPayload,
            verifiedPayment: {
              ...verifiedPayment,
              createdAt: timestamp,
              updatedAt: timestamp
            },
            backgroundJob: queuedJobPayload
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
            });
          }

          clarification = await clarificationRequestRepository.create(clarificationPayload);
          await verifiedPaymentRepository?.updateByPaymentProof?.(verifiedPayment.paymentProof, {
            clarificationId: clarification.clarificationId,
            updatedAt: timestamp
          });
          queuedJob = (await backgroundJobRepository?.create?.(queuedJobPayload)) ?? null;
        }

        const processingJob = queuedJob ? await startBackgroundJob(queuedJob) : null;

        await clarificationRequestRepository.updateByClarificationId(clarification.clarificationId, {
          status: "processing",
          updatedAt: jobTimestamp,
          errorMessage: null,
          retryable: false
        });

        if (!queuedJob) {
          const processingClarification =
            await clarificationRequestRepository.findByClarificationId(
              clarification.clarificationId
            );
          void Promise.resolve()
            .then(() =>
              runAutomaticClarificationPipeline({
                clarification: processingClarification,
                clarificationRequestRepository,
                artifactRepository,
                artifactPublisher,
                marketCacheRepository,
                tradeActivityRepository,
                clarificationFinalityConfig,
                now,
                fetchTradesForSymbol,
                llmTraceability,
                llmRuntime
              })
            )
            .catch(async (pipelineError) => {
              await clarificationRequestRepository.updateByClarificationId(
                clarification.clarificationId,
                {
                  status: "failed",
                  updatedAt: now().toISOString(),
                  errorMessage: pipelineError.message,
                  retryable: true,
                  llmOutput: null
                }
              );
            });
        }

        await sendClarificationCreationResponse({
          response,
          clarification,
          waitOptions,
          job: processingJob,
          headers: verifiedPayment.paymentResponseHeader
            ? {
                "payment-response": verifiedPayment.paymentResponseHeader
              }
            : {}
        });
      } catch (error) {
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

        if (error.statusCode) {
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
        const queue = [];

        for (const market of markets) {
          const latestScan =
            (await reviewerScanRepository?.findLatestByEventId?.(market.marketId)) ?? null;
          const eventClarifications = clarifications.filter(
            (clarification) => clarification.eventId === market.marketId
          );
          const latestClarification =
            eventClarifications
              .slice()
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
              .at(0) ?? null;
          const reviewWindow =
            latestScan?.review_window ??
            buildAdaptiveReviewWindow({
              clarification: {
                llmOutput: {
                  ambiguity_score: 0
                }
              },
              market,
              now: now()
            });
          const fundingProgress = buildQueueFundingProgress(
            latestClarification,
            eventClarifications
          );
          const voteStatus = latestClarification?.reviewerWorkflowStatus ?? "not_started";
          const queueStates = buildQueueStates({
            latestScan,
            fundingProgress,
            reviewWindow,
            voteStatus
          });

          queue.push({
            eventId: market.marketId,
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

        const filters = buildReviewerQueueFilters(queue);
        const activeFilter = requestUrl.searchParams.get("filter");
        const filteredQueue = REVIEWER_QUEUE_FILTERS.some(
          (filter) => filter.key === activeFilter
        )
          ? queue.filter((item) => item.queueStates.includes(activeFilter))
          : queue;
        const availableCategories = await getAvailableCategoriesForStage("active");

        sendJson(response, 200, {
          ok: true,
          ...(activeFilter ? { activeFilter } : {}),
          filters,
          queue: filteredQueue,
          availableCategories: availableCategories.categories
        });
      } catch (error) {
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
        const queue = [];

        for (const market of markets) {
          const latestScan =
            (await upcomingReviewerScanRepository?.findLatestByEventId?.(market.marketId)) ?? null;
          queue.push(
            buildPrelaunchQueueItem({
              market,
              latestScan,
              now: now()
            })
          );
        }

        const availableCategories = await getAvailableCategoriesForStage("upcoming");

        sendJson(response, 200, {
          ok: true,
          queue,
          availableCategories: availableCategories.categories
        });
      } catch (error) {
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
      } catch (error) {
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
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(buildReviewerScanListItem);

        sendJson(response, 200, {
          ok: true,
          scans
        });
      } catch (error) {
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
      } catch (error) {
        if (error.statusCode) {
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
      } catch (error) {
        if (error.statusCode) {
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
        const jobs = [];

        for (const market of markets) {
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
                eventId: market.marketId
              },
              errorMessage: null,
              result: null
            })) ?? null;

          if (queuedJob) {
            jobs.push(await startBackgroundJob(queuedJob));
          } else {
            jobs.push(
              await runReviewerMarketScan({
                eventId: market.marketId,
                marketCacheRepository,
                reviewerScanRepository,
                now
              })
            );
          }
        }

        sendJson(response, 202, {
          ok: true,
          ...(backgroundJobRepository
            ? { jobs: jobs.map(buildBackgroundJobPayload) }
            : { scans: jobs })
        });
      } catch (error) {
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

    if (request.method === "POST" && requestUrl.pathname === "/api/reviewer/prelaunch/scan-all") {
      if (!hasReviewerAccess(request, reviewerAuthToken)) {
        sendReviewerAuthRequired(response);
        return;
      }

      try {
        const markets = ((await upcomingMarketCacheRepository?.list?.()) ?? []).filter((market) =>
          isFutureUpcomingMarket(market, now())
        );
        const jobs = [];

        for (const market of markets) {
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
                eventId: market.marketId,
                marketStage: "upcoming"
              },
              errorMessage: null,
              result: null
            })) ?? null;

          if (queuedJob) {
            jobs.push(await startBackgroundJob(queuedJob));
          } else {
            jobs.push(
              await runReviewerMarketScan({
                eventId: market.marketId,
                marketCacheRepository: upcomingMarketCacheRepository,
                reviewerScanRepository: upcomingReviewerScanRepository,
                now,
                llmRuntime,
                requireUpcomingOpenMarket: true,
                dedupeByMarketText: true,
                inFlightMarketTextScans: upcomingMarketTextScanLocks
              })
            );
          }
        }

        sendJson(response, 202, {
          ok: true,
          ...(backgroundJobRepository
            ? { jobs: jobs.map(buildBackgroundJobPayload) }
            : { scans: jobs })
        });
      } catch (error) {
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
      } catch (error) {
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
          (async (requestedEventId) => {
            if (!cachedMarket?.ticker) {
              const error = new Error("Cached market does not include a Gemini ticker.");
              error.statusCode = 503;
              error.code = "MARKET_REFRESH_UNAVAILABLE";
              throw error;
            }

            return fetchPredictionMarketEventByTicker(cachedMarket.ticker);
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
      } catch (error) {
        if (error.statusCode) {
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
      } catch (error) {
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
            clarificationId: updatedClarification.clarificationId,
            reviewerWorkflowStatus: updatedClarification.reviewerWorkflowStatus,
            vote: buildReviewerVotePayload(updatedClarification)
          }
        });
      } catch (error) {
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

        if (error.statusCode) {
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
            clarificationId: finalizedClarification.clarificationId,
            reviewerWorkflowStatus: finalizedClarification.reviewerWorkflowStatus,
            finalization: {
              finalEditedText: finalizedClarification.finalEditedText,
              finalNote: finalizedClarification.finalNote,
              finalizedAt: finalizedClarification.finalizedAt,
              finalizedBy: finalizedClarification.finalizedBy
            }
          }
        });
      } catch (error) {
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

        if (error.statusCode) {
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
      } catch (error) {
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
                (entry) => entry.reference === contribution.reference
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
          funding: updatedClarification.funding
        });
      } catch (error) {
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

        if (error.statusCode) {
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
          ? await artifactRepository?.findByCid(clarification.artifactCid)
          : null;

        sendJson(response, 200, {
          ok: true,
          audit: buildClarificationAuditPayload({
            clarification,
            artifact
          })
        });
      } catch (error) {
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
          ? await marketCacheRepository?.findByMarketId(clarification.eventId)
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
      } catch (error) {
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
        const artifact = await artifactRepository?.findByCid(cid);

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
      } catch (error) {
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
          requests: requests.map((storedRequest) => ({
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
      } catch (error) {
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
        let deliveryResult = {
          attempted: false,
          sent: false
        };

        if (telegramBotToken) {
          const telegramResponse = await sendTelegramMessage({
            botToken: telegramBotToken,
            chatId: delivery.chatId,
            text: delivery.text,
            apiBaseUrl: telegramBotApiBaseUrl
          });

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
      } catch (error) {
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

        if (error.statusCode) {
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

  server.resumeRecoverableBackgroundJobs = resumeRecoverableBackgroundJobs;
  server.markShuttingDown = () => {
    isShuttingDown = true;
  };

  return server;
}
