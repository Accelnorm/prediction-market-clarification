import http from "node:http";

import { runAutomaticClarificationPipeline as runDefaultAutomaticClarificationPipeline } from "./automatic-llm-pipeline.js";
import { refreshReviewerMarketData } from "./reviewer-refresh-market.js";
import { createTelegramClarificationRequest } from "./telegram-request-flow.js";
import {
  buildTelegramDeliveryPayload,
  parseTelegramStatusUpdate
} from "./telegram-status-delivery.js";
import { buildAdaptiveReviewWindow } from "./review-window-policy.js";
import { createReviewerMarketScan } from "./reviewer-scan-service.js";
import { parsePaidClarificationRequest } from "./x402-paid-clarification.js";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
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
  return {
    clarificationId: clarification.clarificationId,
    status: clarification.status,
    eventId: clarification.eventId,
    question: clarification.question,
    createdAt: clarification.createdAt,
    updatedAt: clarification.updatedAt ?? clarification.createdAt
  };
}

function formatWorkflowLabel(state) {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildFundingDetails(clarifications = []) {
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
    market: {
      marketId: clarification.eventId ?? null,
      title: market?.title ?? null,
      resolutionText: market?.resolution ?? null,
      endTime: market?.closesAt ?? null,
      slug: market?.slug ?? null,
      url: market?.url ?? null
    },
    funding: buildFundingDetails(relatedClarifications),
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
  reviewerScanRepository,
  marketCacheRepository,
  now,
  createRequestId,
  createClarificationId,
  llmTraceability,
  reviewerAuthToken,
  fetchReviewerMarketSource,
  runAutomaticClarificationPipeline = runDefaultAutomaticClarificationPipeline
}) {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");

    if (request.method === "POST" && request.url === "/api/telegram/webhook") {
      try {
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
        const eventId = decodeURIComponent(
          requestUrl.pathname.replace(/^\/api\/clarify\/([^/]+)$/, "$1")
        );
        const payload = parsePaidClarificationRequest(await readJsonBody(request));
        const supportedMarket = await marketCacheRepository?.findByMarketId(eventId);

        if (!supportedMarket) {
          const error = new Error(
            "Event id must match an active synced market before a clarification can be created."
          );
          error.statusCode = 404;
          error.code = "UNSUPPORTED_EVENT_ID";
          throw error;
        }

        const existingClarification =
          await clarificationRequestRepository.findByPaymentProof(payload.paymentProof);

        if (existingClarification) {
          sendJson(response, 200, {
            ok: true,
            clarificationId: existingClarification.clarificationId,
            status: existingClarification.status
          });
          return;
        }

        const timestamp = now().toISOString();
        const clarification = await clarificationRequestRepository.create({
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
          paymentAmount: payload.paymentAmount,
          paymentAsset: payload.paymentAsset,
          paymentReference: payload.paymentReference,
          paymentProof: payload.paymentProof,
          paymentVerifiedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        });

        const processingClarification =
          await clarificationRequestRepository.updateByClarificationId(clarification.clarificationId, {
            status: "processing",
            updatedAt: now().toISOString()
          });

        void Promise.resolve()
          .then(() =>
            runAutomaticClarificationPipeline({
              clarification: processingClarification,
              clarificationRequestRepository,
              artifactRepository,
              marketCacheRepository,
              now,
              llmTraceability
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

        sendJson(response, 202, {
          ok: true,
          clarificationId: clarification.clarificationId,
          status: processingClarification.status
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
          const fundingProgress = buildFundingProgress(eventClarifications);
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

        sendJson(response, 200, {
          ok: true,
          ...(activeFilter ? { activeFilter } : {}),
          filters,
          queue: filteredQueue
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
        const scan = await createReviewerMarketScan({
          eventId,
          marketCacheRepository,
          reviewerScanRepository,
          now
        });

        sendJson(response, 202, {
          ok: true,
          scan
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
        const scans = [];

        for (const market of markets) {
          scans.push(
            await createReviewerMarketScan({
              eventId: market.marketId,
              marketCacheRepository,
              reviewerScanRepository,
              now
            })
          );
        }

        sendJson(response, 202, {
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
        const market = await refreshReviewerMarketData({
          eventId,
          marketCacheRepository,
          fetchReviewerMarketSource,
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

        const market = clarification.eventId
          ? await marketCacheRepository?.findByMarketId(clarification.eventId)
          : null;
        const adaptiveReviewWindow = buildAdaptiveReviewWindow({
          clarification,
          market,
          now: now()
        });

        sendJson(response, 200, {
          ok: true,
          clarification: buildPublicClarificationPayload(clarification)
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
        const relatedClarifications = clarification.eventId
          ? await clarificationRequestRepository.findByEventId(clarification.eventId)
          : [];

        sendJson(response, 200, {
          ok: true,
          clarification: buildReviewerClarificationPayload({
            clarification,
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

        sendJson(response, 200, {
          ok: true,
          requestId: storedRequest.requestId,
          status: storedRequest.status,
          delivery: buildTelegramDeliveryPayload(storedRequest)
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

    sendJson(response, 404, {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found."
      }
    });
  });
}
