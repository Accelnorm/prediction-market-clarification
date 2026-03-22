import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { createServer } from "../src/server.js";
import { FileClarificationRequestRepository } from "../src/clarification-request-repository.js";

async function startTestServer(options) {
  const server = createServer(options);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function stopTestServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
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
      createdAt: "2026-03-21T18:00:00.000Z"
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
