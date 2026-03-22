import http from "node:http";

import { runAutomaticClarificationPipeline as runDefaultAutomaticClarificationPipeline } from "./automatic-llm-pipeline.js";
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

function buildReviewerClarificationPayload({
  clarification,
  adaptiveReviewWindow
}) {
  const clarificationPayload = {
    ...buildPublicClarificationPayload(clarification),
    llmOutput: clarification.llmOutput ?? null,
    llmTrace: clarification.llmTrace ?? null,
    ...adaptiveReviewWindow
  };

  if (clarification.artifactCid && clarification.artifactUrl) {
    clarificationPayload.artifact = {
      cid: clarification.artifactCid,
      url: clarification.artifactUrl
    };
  }

  return clarificationPayload;
}

function buildFundingProgress() {
  return {
    raisedAmount: "0.00",
    targetAmount: "1.00",
    contributorCount: 0,
    fundingState: "unfunded"
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
        const queue = [];

        for (const market of markets) {
          const latestScan =
            (await reviewerScanRepository?.findLatestByEventId?.(market.marketId)) ?? null;
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

          queue.push({
            eventId: market.marketId,
            marketTitle: market.title,
            endTime: market.closesAt,
            ambiguityScore: latestScan?.ambiguity_score ?? null,
            fundingProgress: buildFundingProgress(),
            reviewWindow,
            voteStatus: "not_started"
          });
        }

        sendJson(response, 200, {
          ok: true,
          queue
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

        sendJson(response, 200, {
          ok: true,
          clarification: buildReviewerClarificationPayload({
            clarification,
            adaptiveReviewWindow
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
