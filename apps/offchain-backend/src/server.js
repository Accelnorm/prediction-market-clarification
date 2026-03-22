import http from "node:http";

import { createTelegramClarificationRequest } from "./telegram-request-flow.js";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
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
  now,
  createRequestId
}) {
  return http.createServer(async (request, response) => {
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

    sendJson(response, 404, {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found."
      }
    });
  });
}
