// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { createServer } from "../src/server.js";
import { FileClarificationRequestRepository } from "../src/clarification-request-repository.js";

async function startTestServer(options: any) {
  const server = createServer(options);

  await new Promise((resolve: any) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function stopTestServer(server: any) {
  await new Promise((resolve: any, reject: any) => {
    server.close((error: any) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

test("POST /api/telegram/webhook stores a pending clarification request and returns its deterministic id", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    now: () => new Date("2026-03-21T18:00:00.000Z"),
    createRequestId: () => "clr_telegram_fixed_001"
  });

  try {
    const response = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1001,
        message: {
          message_id: 77,
          chat: {
            id: 9001,
            type: "private"
          },
          from: {
            id: 42,
            username: "marketwatcher"
          },
          text: "/clarify gm_eth_above_5000   Should wick trades above $5,000 count?   "
        }
      })
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      requestId: "clr_telegram_fixed_001",
      status: "pending"
    });

    const stored = JSON.parse(
      await readFile(path.join(tempDir, "clarification-requests.json"), "utf8")
    );

    assert.equal(stored.requests.length, 1);
    assert.deepEqual(stored.requests[0], {
      requestId: "clr_telegram_fixed_001",
      source: "telegram",
      status: "pending",
      marketId: "gm_eth_above_5000",
      question: "Should wick trades above $5,000 count?",
      telegramChatId: "9001",
      telegramUserId: "42",
      telegramUsername: "marketwatcher",
      createdAt: "2026-03-21T18:00:00.000Z",
      updatedAt: "2026-03-21T18:00:00.000Z",
      clarificationId: null,
      summary: null,
      errorMessage: null,
      retryable: false,
      llmOutput: null,
      llmTrace: null,
      artifactCid: null,
      artifactUrl: null,
      reviewerWorkflowStatus: null,
      finalEditedText: null,
      finalNote: null,
      finalizedAt: null,
      finalizedBy: null,
      reviewerActions: [],
      statusHistory: [
        {
          status: "pending",
          timestamp: "2026-03-21T18:00:00.000Z"
        }
      ]
    });
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/telegram/webhook rejects requests with a missing webhook secret when configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    telegramWebhookSecret: "telegram-secret"
  });

  try {
    const response = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1001,
        message: {
          message_id: 77,
          chat: {
            id: 9001,
            type: "private"
          },
          from: {
            id: 42
          },
          text: "/clarify gm_eth_above_5000 Should wick trades above $5,000 count?"
        }
      })
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "TELEGRAM_WEBHOOK_FORBIDDEN",
        message: "Telegram webhook secret token is invalid."
      }
    });

    const stored = await repository.load();
    assert.deepEqual(stored.requests, []);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/telegram/webhook accepts requests with the configured webhook secret", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    telegramWebhookSecret: "telegram-secret",
    createRequestId: () => "clr_telegram_secret_001"
  });

  try {
    const response = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-secret"
      },
      body: JSON.stringify({
        update_id: 1001,
        message: {
          message_id: 77,
          chat: {
            id: 9001,
            type: "private"
          },
          from: {
            id: 42
          },
          text: "/clarify gm_eth_above_5000 Should wick trades above $5,000 count?"
        }
      })
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      requestId: "clr_telegram_secret_001",
      status: "pending"
    });
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/telegram/webhook rejects empty clarification questions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    createRequestId: () => "unused_request_id"
  });

  try {
    const response = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1002,
        message: {
          message_id: 78,
          chat: {
            id: 9002,
            type: "private"
          },
          from: {
            id: 43
          },
          text: "/clarify gm_eth_above_5000    "
        }
      })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "INVALID_QUESTION",
        message: "Clarification question cannot be empty."
      }
    });

    const stored = await repository.load();
    assert.deepEqual(stored.requests, []);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/telegram/webhook rejects invalid market identifiers with an actionable error", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    createRequestId: () => "unused_request_id"
  });

  try {
    const response = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1003,
        message: {
          message_id: 79,
          chat: {
            id: 9003,
            type: "private"
          },
          from: {
            id: 44
          },
          text: "/clarify market 123 Will this resolve using Gemini spot only?"
        }
      })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "INVALID_MARKET_ID",
        message: "Market identifier must use Gemini market id format, for example gm_eth_above_5000."
      }
    });

    const stored = await repository.load();
    assert.deepEqual(stored.requests, []);
  } finally {
    await stopTestServer(server);
  }
});

test("GET /api/telegram/requests can look up clarification requests by originating chat and user identifiers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    now: () => new Date("2026-03-21T18:10:00.000Z"),
    createRequestId: () => "clr_telegram_lookup_001"
  });

  try {
    const createResponse = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1004,
        message: {
          message_id: 80,
          chat: {
            id: 9010,
            type: "private"
          },
          from: {
            id: 55,
            username: "lookupuser"
          },
          text: "/clarify gm_btc_above_100k Will Gemini auction prints count?"
        }
      })
    });

    assert.equal(createResponse.status, 202);

    const response = await fetch(
      `${baseUrl}/api/telegram/requests?chat_id=9010&user_id=55`
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requests: [
        {
          requestId: "clr_telegram_lookup_001",
          status: "pending",
          marketId: "gm_btc_above_100k",
          question: "Will Gemini auction prints count?",
          telegramChatId: "9010",
          telegramUserId: "55",
          clarificationId: null,
          summary: null,
          errorMessage: null,
          createdAt: "2026-03-21T18:10:00.000Z",
          updatedAt: "2026-03-21T18:10:00.000Z"
        }
      ]
    });
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/telegram/requests/:requestId/status emits processing and completed delivery payloads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const timestamps = [
    new Date("2026-03-21T18:20:00.000Z"),
    new Date("2026-03-21T18:21:00.000Z"),
    new Date("2026-03-21T18:22:00.000Z")
  ];
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    now: () => timestamps.shift() ?? new Date("2026-03-21T18:22:00.000Z"),
    createRequestId: () => "clr_telegram_status_001"
  });

  try {
    await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1005,
        message: {
          message_id: 81,
          chat: {
            id: 9011,
            type: "private"
          },
          from: {
            id: 56
          },
          text: "/clarify gm_sol_above_500 Does the daily candle close decide the result?"
        }
      })
    });

    const processingResponse = await fetch(
      `${baseUrl}/api/telegram/requests/clr_telegram_status_001/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          status: "processing"
        })
      }
    );

    assert.equal(processingResponse.status, 200);
    assert.deepEqual(await processingResponse.json(), {
      ok: true,
      requestId: "clr_telegram_status_001",
      status: "processing",
      delivery: {
        chatId: "9011",
        text: "Clarification request clr_telegram_status_001 is processing for market gm_sol_above_500."
      },
      deliveryResult: {
        attempted: false,
        sent: false
      }
    });

    const completedResponse = await fetch(
      `${baseUrl}/api/telegram/requests/clr_telegram_status_001/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          status: "completed",
          clarificationId: "clar_001",
          summary: "Gemini auction and spot prints both count toward resolution."
        })
      }
    );

    assert.equal(completedResponse.status, 200);
    assert.deepEqual(await completedResponse.json(), {
      ok: true,
      requestId: "clr_telegram_status_001",
      status: "completed",
      delivery: {
        chatId: "9011",
        text: "Clarification clar_001 completed for request clr_telegram_status_001: Gemini auction and spot prints both count toward resolution."
      },
      deliveryResult: {
        attempted: false,
        sent: false
      }
    });

    const stored = await repository.load();
    assert.equal(stored.requests[0].status, "completed");
    assert.equal(stored.requests[0].clarificationId, "clar_001");
    assert.equal(
      stored.requests[0].summary,
      "Gemini auction and spot prints both count toward resolution."
    );
    assert.deepEqual(
      stored.requests[0].statusHistory.map((entry: any) => entry.status),
      ["pending", "processing", "completed"]
    );
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/telegram/requests/:requestId/status sends the delivery through Telegram when a bot token is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const sentMessages = [];
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    now: () => new Date("2026-03-21T18:20:00.000Z"),
    createRequestId: () => "clr_telegram_delivery_001",
    telegramBotToken: "telegram-bot-token",
    sendTelegramMessage: async (message: any) => {
      sentMessages.push(message);
      return {
        ok: true,
        messageId: 4321
      };
    }
  });

  try {
    await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1005,
        message: {
          message_id: 81,
          chat: {
            id: 9011,
            type: "private"
          },
          from: {
            id: 56
          },
          text: "/clarify gm_sol_above_500 Does the daily candle close decide the result?"
        }
      })
    });

    const completedResponse = await fetch(
      `${baseUrl}/api/telegram/requests/clr_telegram_delivery_001/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          status: "completed",
          clarificationId: "clar_001",
          summary: "Gemini auction and spot prints both count toward resolution."
        })
      }
    );

    assert.equal(completedResponse.status, 200);
    assert.deepEqual(await completedResponse.json(), {
      ok: true,
      requestId: "clr_telegram_delivery_001",
      status: "completed",
      delivery: {
        chatId: "9011",
        text: "Clarification clar_001 completed for request clr_telegram_delivery_001: Gemini auction and spot prints both count toward resolution."
      },
      deliveryResult: {
        attempted: true,
        sent: true,
        messageId: 4321
      }
    });

    assert.deepEqual(sentMessages, [
      {
        botToken: "telegram-bot-token",
        chatId: "9011",
        text: "Clarification clar_001 completed for request clr_telegram_delivery_001: Gemini auction and spot prints both count toward resolution.",
        apiBaseUrl: undefined
      }
    ]);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/telegram/requests/:requestId/status emits sanitized failed delivery payloads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telegram-webhook-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const timestamps = [
    new Date("2026-03-21T18:30:00.000Z"),
    new Date("2026-03-21T18:31:00.000Z")
  ];
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    now: () => timestamps.shift() ?? new Date("2026-03-21T18:31:00.000Z"),
    createRequestId: () => "clr_telegram_failed_001"
  });

  try {
    await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        update_id: 1006,
        message: {
          message_id: 82,
          chat: {
            id: 9012,
            type: "private"
          },
          from: {
            id: 57
          },
          text: "/clarify gm_eth_below_2k Does the market use any non-USD Gemini pairs?"
        }
      })
    });

    const failedResponse = await fetch(
      `${baseUrl}/api/telegram/requests/clr_telegram_failed_001/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage:
            "Interpretation failed. Error: stack trace at worker.js:12:4 should not be exposed."
        })
      }
    );

    assert.equal(failedResponse.status, 200);
    assert.deepEqual(await failedResponse.json(), {
      ok: true,
      requestId: "clr_telegram_failed_001",
      status: "failed",
      delivery: {
        chatId: "9012",
        text: "Clarification request clr_telegram_failed_001 failed. Please retry later."
      },
      deliveryResult: {
        attempted: false,
        sent: false
      }
    });

    const stored = await repository.load();
    assert.equal(stored.requests[0].status, "failed");
    assert.equal(
      stored.requests[0].errorMessage,
      "Interpretation failed. Error: stack trace at worker.js:12:4 should not be exposed."
    );
  } finally {
    await stopTestServer(server);
  }
});
