import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { createServer } from "../src/server.js";
import { FileArtifactRepository } from "../src/artifact-repository.js";
import { FileClarificationRequestRepository } from "../src/clarification-request-repository.js";
import { FileMarketCacheRepository } from "../src/market-cache-repository.js";

const VALID_MARKET = {
  marketId: "gm_btc_above_100k",
  title: "Will BTC trade above $100,000 before year end?",
  resolution: "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
  closesAt: "2026-12-31T23:59:00.000Z",
  slug: "btc-above-100k-2026",
  url: "https://example.com/markets/btc-above-100k-2026",
  lastSyncedAt: "2026-03-21T18:59:00.000Z"
};

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

function createReviewerHeaders(token = "reviewer-secret") {
  return {
    "x-reviewer-token": token
  };
}

async function createMarketCacheRepository(tempDir, markets = [VALID_MARKET]) {
  const repository = new FileMarketCacheRepository(path.join(tempDir, "market-cache.json"));
  await repository.save(markets);
  return repository;
}

async function waitFor(assertion, { attempts = 25, delayMs = 10 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }

  throw lastError;
}

test("POST /api/clarify/:eventId rejects unpaid requests", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
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
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:05:00.000Z"),
    createClarificationId: () => "clar_paid_001",
    runAutomaticClarificationPipeline: async () => {}
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
      normalizedInput: {
        eventId: "gm_btc_above_100k",
        question: "Should trades during a maintenance window count?"
      },
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
      retryable: false,
      llmOutput: null,
      llmTrace: null,
      artifactCid: null,
      artifactUrl: null,
      statusHistory: [
        {
          status: "queued",
          timestamp: "2026-03-21T19:05:00.000Z"
        },
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

test("POST /api/clarify/:eventId rejects unsupported event ids", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:10:00.000Z"),
    createClarificationId: () => "clar_paid_unused"
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_unknown_market`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_unsupported",
        question: "Does this market exist in the synced cache?",
        payment: {
          proof: "pay_proof_unsupported",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_unsupported",
          verified: true
        }
      })
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "UNSUPPORTED_EVENT_ID",
        message: "Event id must match an active synced market before a clarification can be created."
      }
    });

    const stored = await repository.load();
    assert.deepEqual(stored.requests, []);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId rejects blank and overlong paid clarification questions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:15:00.000Z"),
    createClarificationId: () => "clar_paid_unused"
  });

  try {
    const blankResponse = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_blank",
        question: "    ",
        payment: {
          proof: "pay_proof_blank",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_blank",
          verified: true
        }
      })
    });

    assert.equal(blankResponse.status, 400);
    assert.deepEqual(await blankResponse.json(), {
      ok: false,
      error: {
        code: "INVALID_QUESTION",
        message: "Clarification question cannot be empty."
      }
    });

    const overlongResponse = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_long",
        question: "a".repeat(501),
        payment: {
          proof: "pay_proof_long",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_long",
          verified: true
        }
      })
    });

    assert.equal(overlongResponse.status, 400);
    assert.deepEqual(await overlongResponse.json(), {
      ok: false,
      error: {
        code: "QUESTION_TOO_LONG",
        message: "Clarification question must be 500 characters or fewer."
      }
    });

    const stored = await repository.load();
    assert.deepEqual(stored.requests, []);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId stores normalized paid request input for comparable duplicates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  let nextClarification = 1;
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:20:00.000Z"),
    createClarificationId: () => `clar_paid_norm_${String(nextClarification++).padStart(3, "0")}`,
    runAutomaticClarificationPipeline: async () => {}
  });

  try {
    const firstPayload = {
      requesterId: "wallet_norm_1",
      question: "  Should   Gemini auction   prints count?  ",
      payment: {
        proof: "pay_proof_norm_1",
        amount: "1.00",
        asset: "USDC",
        reference: "x402_ref_norm_1",
        verified: true
      }
    };
    const secondPayload = {
      requesterId: "wallet_norm_2",
      question: "Should Gemini auction prints count?",
      payment: {
        proof: "pay_proof_norm_2",
        amount: "1.00",
        asset: "USDC",
        reference: "x402_ref_norm_2",
        verified: true
      }
    };

    const firstResponse = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(firstPayload)
    });
    const secondResponse = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(secondPayload)
    });

    assert.equal(firstResponse.status, 202);
    assert.equal(secondResponse.status, 202);

    const stored = JSON.parse(
      await readFile(path.join(tempDir, "clarification-requests.json"), "utf8")
    );

    assert.equal(stored.requests.length, 2);
    assert.equal(stored.requests[0].question, "Should Gemini auction prints count?");
    assert.equal(stored.requests[1].question, "Should Gemini auction prints count?");
    assert.deepEqual(stored.requests.map((request) => request.normalizedInput), [
      {
        eventId: "gm_btc_above_100k",
        question: "Should Gemini auction prints count?"
      },
      {
        eventId: "gm_btc_above_100k",
        question: "Should Gemini auction prints count?"
      }
    ]);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId automatically runs the interpretation pipeline and stores completed output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:25:00.000Z"),
    createClarificationId: () => "clar_paid_pipeline_001"
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_pipeline",
        question: "Should the market resolve from Gemini BTC/USD spot prints only?",
        payment: {
          proof: "pay_proof_pipeline_001",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_pipeline_001",
          verified: true
        }
      })
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      clarificationId: "clar_paid_pipeline_001",
      status: "processing"
    });

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_pipeline_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "completed");
    });

    const storedRequest = await repository.findByClarificationId("clar_paid_pipeline_001");
    assert.deepEqual(storedRequest.statusHistory, [
      {
        status: "queued",
        timestamp: "2026-03-21T19:25:00.000Z"
      },
      {
        status: "processing",
        timestamp: "2026-03-21T19:25:00.000Z"
      },
      {
        status: "completed",
        timestamp: "2026-03-21T19:25:00.000Z"
      }
    ]);
    assert.deepEqual(storedRequest.llmOutput, {
      verdict: "needs_clarification",
      llm_status: "completed",
      reasoning:
        "The market text depends on Gemini BTC/USD spot prints but leaves room for ambiguity around which Gemini price feed or session record is authoritative.",
      cited_clause:
        "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
      ambiguity_score: 0.72,
      ambiguity_summary:
        "The resolution source is named at a high level, but the exact qualifying Gemini print is not explicit.",
      suggested_market_text:
        "Will Gemini BTC/USD spot trade above $100,000 on the primary Gemini exchange feed before December 31 2026 23:59 UTC?",
      suggested_note:
        "Use Gemini's primary BTC/USD spot exchange feed and count the first eligible trade print above $100,000 before expiry."
    });
    assert.equal(storedRequest.errorMessage, null);
  } finally {
    await stopTestServer(server);
  }
});

test("successful clarifications automatically publish an artifact and store a fetchable IPFS reference", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const artifactRepository = new FileArtifactRepository(path.join(tempDir, "artifacts.json"));
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    artifactRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:26:00.000Z"),
    createClarificationId: () => "clar_paid_artifact_001",
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_artifact",
        question: "Should the primary Gemini feed be the only source for resolution?",
        payment: {
          proof: "pay_proof_artifact_001",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_artifact_001",
          verified: true
        }
      })
    });

    assert.equal(response.status, 202);

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_artifact_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "completed");
      assert.match(storedRequest.artifactCid ?? "", /^bafy[a-z0-9]+$/);
      assert.equal(storedRequest.artifactUrl, `ipfs://${storedRequest.artifactCid}`);
    });

    const storedRequest = await repository.findByClarificationId("clar_paid_artifact_001");
    const unauthorizedArtifactResponse = await fetch(
      `${baseUrl}/api/artifacts/${encodeURIComponent(storedRequest.artifactCid)}`
    );

    assert.equal(unauthorizedArtifactResponse.status, 401);
    assert.deepEqual(await unauthorizedArtifactResponse.json(), {
      ok: false,
      error: {
        code: "REVIEWER_AUTH_REQUIRED",
        message: "Reviewer authentication is required for this route."
      }
    });

    const artifactResponse = await fetch(
      `${baseUrl}/api/artifacts/${encodeURIComponent(storedRequest.artifactCid)}`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(artifactResponse.status, 200);
    assert.deepEqual(await artifactResponse.json(), {
      ok: true,
      artifact: {
        cid: storedRequest.artifactCid,
        url: storedRequest.artifactUrl,
        clarificationId: "clar_paid_artifact_001",
        eventId: "gm_btc_above_100k",
        marketText: VALID_MARKET.resolution,
        suggestedEditedMarketText: storedRequest.llmOutput.suggested_market_text,
        clarificationNote: storedRequest.llmOutput.suggested_note,
        generatedAtUtc: "2026-03-21T19:26:00.000Z"
      }
    });

    const detailResponse = await fetch(`${baseUrl}/api/clarifications/clar_paid_artifact_001`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.clarification.artifact, undefined);

    const reviewerDetailResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_paid_artifact_001`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(reviewerDetailResponse.status, 200);
    const reviewerDetailPayload = await reviewerDetailResponse.json();
    assert.deepEqual(reviewerDetailPayload.clarification.artifact, {
      cid: storedRequest.artifactCid,
      url: storedRequest.artifactUrl
    });
  } finally {
    await stopTestServer(server);
  }
});

test("completed clarifications store immutable LLM trace metadata and expose it through detail reads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  let firstNowCallCount = 0;
  const firstTimeline = [
    "2026-03-21T19:27:00.000Z",
    "2026-03-21T19:27:01.000Z",
    "2026-03-21T19:27:02.000Z",
    "2026-03-21T19:27:03.000Z"
  ];
  const firstServerState = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () =>
      new Date(firstTimeline[Math.min(firstNowCallCount++, firstTimeline.length - 1)]),
    createClarificationId: () => "clar_paid_trace_001",
    reviewerAuthToken: "reviewer-secret",
    llmTraceability: {
      promptTemplateVersion: "prompt-v1",
      modelId: "gemini-reviewer-001",
      processingVersion: "offchain-pipeline-2026-03-21"
    }
  });
  let secondServerState = null;

  try {
    const firstResponse = await fetch(
      `${firstServerState.baseUrl}/api/clarify/gm_btc_above_100k`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requesterId: "wallet_trace_1",
          question: "Should Gemini BTC/USD auction prints be excluded?",
          payment: {
            proof: "pay_proof_trace_001",
            amount: "1.00",
            asset: "USDC",
            reference: "x402_ref_trace_001",
            verified: true
          }
        })
      }
    );

    assert.equal(firstResponse.status, 202);

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_trace_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "completed");
      assert.deepEqual(storedRequest.llmTrace, {
        promptTemplateVersion: "prompt-v1",
        modelId: "gemini-reviewer-001",
        requestedAt: "2026-03-21T19:27:02.000Z",
        processingVersion: "offchain-pipeline-2026-03-21"
      });
    });

    const detailResponse = await fetch(
      `${firstServerState.baseUrl}/api/clarifications/clar_paid_trace_001`
    );
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(await detailResponse.json(), {
      ok: true,
      clarification: {
        clarificationId: "clar_paid_trace_001",
        status: "completed",
        eventId: "gm_btc_above_100k",
        question: "Should Gemini BTC/USD auction prints be excluded?",
        createdAt: "2026-03-21T19:27:00.000Z",
        updatedAt: "2026-03-21T19:27:03.000Z"
      }
    });

    const unauthorizedReviewerResponse = await fetch(
      `${firstServerState.baseUrl}/api/reviewer/clarifications/clar_paid_trace_001`
    );
    assert.equal(unauthorizedReviewerResponse.status, 401);
    assert.deepEqual(await unauthorizedReviewerResponse.json(), {
      ok: false,
      error: {
        code: "REVIEWER_AUTH_REQUIRED",
        message: "Reviewer authentication is required for this route."
      }
    });

    const reviewerDetailResponse = await fetch(
      `${firstServerState.baseUrl}/api/reviewer/clarifications/clar_paid_trace_001`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(reviewerDetailResponse.status, 200);
    assert.deepEqual(await reviewerDetailResponse.json(), {
      ok: true,
      clarification: {
        clarificationId: "clar_paid_trace_001",
        status: "completed",
        eventId: "gm_btc_above_100k",
        question: "Should Gemini BTC/USD auction prints be excluded?",
        llmOutput: {
          verdict: "needs_clarification",
          llm_status: "completed",
          reasoning:
            "The market text depends on Gemini BTC/USD spot prints but leaves room for ambiguity around which Gemini price feed or session record is authoritative.",
          cited_clause:
            "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
          ambiguity_score: 0.72,
          ambiguity_summary:
            "The resolution source is named at a high level, but the exact qualifying Gemini print is not explicit.",
          suggested_market_text:
            "Will Gemini BTC/USD spot trade above $100,000 on the primary Gemini exchange feed before December 31 2026 23:59 UTC?",
          suggested_note:
            "Use Gemini's primary BTC/USD spot exchange feed and count the first eligible trade print above $100,000 before expiry."
        },
        llmTrace: {
          promptTemplateVersion: "prompt-v1",
          modelId: "gemini-reviewer-001",
          requestedAt: "2026-03-21T19:27:02.000Z",
          processingVersion: "offchain-pipeline-2026-03-21"
        },
        createdAt: "2026-03-21T19:27:00.000Z",
        updatedAt: "2026-03-21T19:27:03.000Z",
        review_window_secs: 86400,
        review_window_reason:
          "Base window set from gt_72h time-to-end bucket. Final window 86400 seconds within 3600-86400 second policy bounds.",
        time_to_end_bucket: "gt_72h",
        activity_signal: "normal",
        ambiguity_score: 0.72
      }
    });

    await stopTestServer(firstServerState.server);

    let secondNowCallCount = 0;
    const secondTimeline = [
      "2026-03-21T19:28:00.000Z",
      "2026-03-21T19:28:01.000Z",
      "2026-03-21T19:28:02.000Z",
      "2026-03-21T19:28:03.000Z"
    ];
    secondServerState = await startTestServer({
      clarificationRequestRepository: repository,
      marketCacheRepository,
      now: () =>
        new Date(secondTimeline[Math.min(secondNowCallCount++, secondTimeline.length - 1)]),
      createClarificationId: () => "clar_paid_trace_002",
      reviewerAuthToken: "reviewer-secret",
      llmTraceability: {
        promptTemplateVersion: "prompt-v2",
        modelId: "gemini-reviewer-001",
        processingVersion: "offchain-pipeline-2026-03-22"
      }
    });

    const secondResponse = await fetch(
      `${secondServerState.baseUrl}/api/clarify/gm_btc_above_100k`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requesterId: "wallet_trace_2",
          question: "Should only continuous spot prints count?",
          payment: {
            proof: "pay_proof_trace_002",
            amount: "1.00",
            asset: "USDC",
            reference: "x402_ref_trace_002",
            verified: true
          }
        })
      }
    );

    assert.equal(secondResponse.status, 202);

    await waitFor(async () => {
      const secondStoredRequest = await repository.findByClarificationId("clar_paid_trace_002");
      assert.ok(secondStoredRequest);
      assert.equal(secondStoredRequest.status, "completed");
      assert.deepEqual(secondStoredRequest.llmTrace, {
        promptTemplateVersion: "prompt-v2",
        modelId: "gemini-reviewer-001",
        requestedAt: "2026-03-21T19:28:02.000Z",
        processingVersion: "offchain-pipeline-2026-03-22"
      });
    });

    const firstStoredRequest = await repository.findByClarificationId("clar_paid_trace_001");
    assert.deepEqual(firstStoredRequest.llmTrace, {
      promptTemplateVersion: "prompt-v1",
      modelId: "gemini-reviewer-001",
      requestedAt: "2026-03-21T19:27:02.000Z",
      processingVersion: "offchain-pipeline-2026-03-21"
    });
  } finally {
    if (secondServerState) {
      await stopTestServer(secondServerState.server);
    } else {
      await stopTestServer(firstServerState.server);
    }
  }
});

test("reviewer-only clarification routes reject incorrect reviewer tokens", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);

  await repository.create({
    clarificationId: "clar_reviewer_auth_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should only Gemini spot prints count?",
    llmOutput: {
      ambiguity_score: 0.61
    },
    createdAt: "2026-03-21T19:29:00.000Z",
    updatedAt: "2026-03-21T19:29:00.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:29:00.000Z"),
    createClarificationId: () => "unused",
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const response = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_reviewer_auth_001`,
      {
        headers: createReviewerHeaders("wrong-reviewer-secret")
      }
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "REVIEWER_AUTH_REQUIRED",
        message: "Reviewer authentication is required for this route."
      }
    });
  } finally {
    await stopTestServer(server);
  }
});

test("clarification detail responses include adaptive review windows bounded between one and twenty-four hours", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir, [
    {
      ...VALID_MARKET,
      marketId: "gm_review_long",
      closesAt: "2026-03-26T12:00:00.000Z",
      activitySignal: "low"
    },
    {
      ...VALID_MARKET,
      marketId: "gm_review_active",
      closesAt: "2026-03-23T04:00:00.000Z",
      activitySignal: "high"
    },
    {
      ...VALID_MARKET,
      marketId: "gm_review_ambiguous",
      closesAt: "2026-03-21T22:00:00.000Z",
      activitySignal: "normal"
    },
    {
      ...VALID_MARKET,
      marketId: "gm_review_urgent",
      closesAt: "2026-03-21T17:00:00.000Z",
      activitySignal: "high"
    }
  ]);

  await repository.create({
    clarificationId: "clar_review_long",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_review_long",
    question: "Long dated review window?",
    llmOutput: {
      ambiguity_score: 0.4
    },
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:00:00.000Z"
  });
  await repository.create({
    clarificationId: "clar_review_active",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_review_active",
    question: "High activity review window?",
    llmOutput: {
      ambiguity_score: 0.52
    },
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:00:00.000Z"
  });
  await repository.create({
    clarificationId: "clar_review_ambiguous",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_review_ambiguous",
    question: "Near expiry ambiguity review window?",
    llmOutput: {
      ambiguity_score: 0.91
    },
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:00:00.000Z"
  });
  await repository.create({
    clarificationId: "clar_review_urgent",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_review_urgent",
    question: "Urgent review window?",
    llmOutput: {
      ambiguity_score: 0.97
    },
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:00:00.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T12:00:00.000Z"),
    createClarificationId: () => "unused",
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const longResponse = await fetch(`${baseUrl}/api/reviewer/clarifications/clar_review_long`, {
      headers: createReviewerHeaders()
    });
    assert.equal(longResponse.status, 200);
    const longPayload = await longResponse.json();
    assert.equal(longPayload.clarification.review_window_secs, 86400);
    assert.equal(longPayload.clarification.time_to_end_bucket, "gt_72h");
    assert.equal(longPayload.clarification.activity_signal, "low");
    assert.equal(longPayload.clarification.ambiguity_score, 0.4);

    const activeResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_review_active`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(activeResponse.status, 200);
    const activePayload = await activeResponse.json();
    assert.equal(activePayload.clarification.review_window_secs, 28800);
    assert.equal(activePayload.clarification.time_to_end_bucket, "between_24h_and_72h");
    assert.equal(activePayload.clarification.activity_signal, "high");
    assert.equal(activePayload.clarification.ambiguity_score, 0.52);

    const ambiguousResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_review_ambiguous`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(ambiguousResponse.status, 200);
    const ambiguousPayload = await ambiguousResponse.json();
    assert.equal(ambiguousPayload.clarification.review_window_secs, 14400);
    assert.equal(ambiguousPayload.clarification.time_to_end_bucket, "between_6h_and_24h");
    assert.equal(ambiguousPayload.clarification.activity_signal, "normal");
    assert.equal(ambiguousPayload.clarification.ambiguity_score, 0.91);

    const urgentResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_review_urgent`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(urgentResponse.status, 200);
    const urgentPayload = await urgentResponse.json();
    assert.equal(urgentPayload.clarification.review_window_secs, 3600);
    assert.equal(urgentPayload.clarification.time_to_end_bucket, "lt_6h");
    assert.equal(urgentPayload.clarification.activity_signal, "high");
    assert.equal(urgentPayload.clarification.ambiguity_score, 0.97);

    for (const payload of [
      longPayload.clarification,
      activePayload.clarification,
      ambiguousPayload.clarification,
      urgentPayload.clarification
    ]) {
      assert.equal(typeof payload.review_window_reason, "string");
      assert.ok(payload.review_window_reason.length > 0);
      assert.ok(payload.review_window_secs >= 3600);
      assert.ok(payload.review_window_secs <= 86400);
    }
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId marks automatic interpretation failures as retryable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:30:00.000Z"),
    createClarificationId: () => "clar_paid_pipeline_fail_001",
    runAutomaticClarificationPipeline: async () => {
      throw new Error("LLM provider timeout");
    }
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_pipeline_fail",
        question: "What source data settles the market if Gemini pauses trading?",
        payment: {
          proof: "pay_proof_pipeline_fail_001",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_pipeline_fail_001",
          verified: true
        }
      })
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      clarificationId: "clar_paid_pipeline_fail_001",
      status: "processing"
    });

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_pipeline_fail_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "failed");
    });

    const storedRequest = await repository.findByClarificationId("clar_paid_pipeline_fail_001");
    assert.equal(storedRequest.errorMessage, "LLM provider timeout");
    assert.equal(storedRequest.retryable, true);
    assert.equal(storedRequest.llmOutput, null);
    assert.deepEqual(storedRequest.statusHistory, [
      {
        status: "queued",
        timestamp: "2026-03-21T19:30:00.000Z"
      },
      {
        status: "processing",
        timestamp: "2026-03-21T19:30:00.000Z"
      },
      {
        status: "failed",
        timestamp: "2026-03-21T19:30:00.000Z"
      }
    ]);
  } finally {
    await stopTestServer(server);
  }
});
