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

test("POST /api/clarify/:eventId rejects unpaid requests", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    now: () => new Date("2026-03-21T19:00:00.000Z"),
    createClarificationId: () => "clar_paid_unused"
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_eth_above_5000`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_001",
        question: "Does Gemini auction data resolve the market?",
        payment: {
          proof: "pay_proof_missing_verification",
          amount: "1.00",
          asset: "USDC",
          reference: "xref_unpaid_001"
        }
      })
    });

    assert.equal(response.status, 402);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "PAYMENT_REQUIRED",
        message: "A verified x402 payment of 1.00 USDC is required before creating a clarification."
      }
    });

    const stored = await repository.load();
    assert.deepEqual(stored.requests, []);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId creates a processing clarification after verified x402 payment and deduplicates by payment proof", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    now: () => new Date("2026-03-21T19:05:00.000Z"),
    createClarificationId: () => "clar_paid_001"
  });

  const payload = {
    requesterId: "wallet_123",
    question: "Should trades during a maintenance window count?",
    payment: {
      proof: "pay_proof_001",
      amount: "1.00",
      asset: "USDC",
      reference: "x402_ref_001",
      verified: true
    }
  };

  try {
    const firstResponse = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    assert.equal(firstResponse.status, 202);
    assert.deepEqual(await firstResponse.json(), {
      ok: true,
      clarificationId: "clar_paid_001",
      status: "processing"
    });

    const replayResponse = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    assert.equal(replayResponse.status, 200);
    assert.deepEqual(await replayResponse.json(), {
      ok: true,
      clarificationId: "clar_paid_001",
      status: "processing"
    });

    const stored = JSON.parse(
      await readFile(path.join(tempDir, "clarification-requests.json"), "utf8")
    );

    assert.equal(stored.requests.length, 1);
    assert.deepEqual(stored.requests[0], {
      clarificationId: "clar_paid_001",
      requestId: null,
      source: "paid_api",
      status: "processing",
      eventId: "gm_btc_above_100k",
      question: "Should trades during a maintenance window count?",
      requesterId: "wallet_123",
      paymentAmount: "1.00",
      paymentAsset: "USDC",
      paymentReference: "x402_ref_001",
      paymentProof: "pay_proof_001",
      paymentVerifiedAt: "2026-03-21T19:05:00.000Z",
      createdAt: "2026-03-21T19:05:00.000Z",
      updatedAt: "2026-03-21T19:05:00.000Z",
      summary: null,
      errorMessage: null,
      statusHistory: [
        {
          status: "processing",
          timestamp: "2026-03-21T19:05:00.000Z"
        }
      ]
    });
  } finally {
    await stopTestServer(server);
  }
});
