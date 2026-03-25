import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import { createServer } from "../src/server.js";
import { FileArtifactRepository } from "../src/artifact-repository.js";
import { FileBackgroundJobRepository } from "../src/background-job-repository.js";
import { FileClarificationRequestRepository } from "../src/clarification-request-repository.js";
import { FileMarketCacheRepository } from "../src/market-cache-repository.js";
import { FileReviewerScanRepository } from "../src/reviewer-scan-repository.js";
import { FileTradeActivityRepository } from "../src/trade-activity-repository.js";
import { FileVerifiedPaymentRepository } from "../src/verified-payment-repository.js";
import { buildX402PaymentRequiredHeader } from "../src/x402-payment-challenge.js";

const DEFAULT_X402_PAYMENT_CONFIG = {
  x402Version: 2,
  scheme: "exact",
  priceUsd: "1.00",
  maxAmountRequired: "1000000",
  assetSymbol: "USDC",
  network: "solana-devnet",
  cluster: "devnet",
  mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  recipientAddress: "11111111111111111111111111111111",
  feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
  maxTimeoutSeconds: 300,
  facilitatorUrl: "https://facilitator.payai.network",
  facilitatorAuthToken: "test-token",
  verificationSource: "test_verifier"
};

const VALID_MARKET = {
  marketId: "gm_btc_above_100k",
  title: "Will BTC trade above $100,000 before year end?",
  resolution: "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
  closesAt: "2026-12-31T23:59:00.000Z",
  slug: "btc-above-100k-2026",
  url: "https://example.com/markets/btc-above-100k-2026",
  lastSyncedAt: "2026-03-21T18:59:00.000Z"
};

const UPCOMING_MARKET = {
  marketId: "gm_sol_above_500",
  title: "Will SOL trade above $500 before year end?",
  resolution: "Resolves YES if Gemini SOL/USD prints above $500 before December 31 2026 23:59 UTC.",
  closesAt: "2026-12-31T23:59:00.000Z",
  effectiveDate: "2026-04-01T00:00:00.000Z",
  slug: "sol-above-500-2026",
  url: "https://example.com/markets/sol-above-500-2026",
  status: "approved",
  lastSyncedAt: "2026-03-21T18:59:00.000Z"
};

const EXPECTED_PAYMENT_FEE_PAYER = DEFAULT_X402_PAYMENT_CONFIG.feePayer;

type TestServerOptions = Partial<Parameters<typeof createServer>[0]>;

async function startTestServer(options: TestServerOptions) {
  const verifiedPaymentRepository =
    options.verifiedPaymentRepository ??
    new FileVerifiedPaymentRepository(
      path.join(
        os.tmpdir(),
        `verified-payments-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
      )
    );
  const verifyX402Payment =
    options.verifyX402Payment ??
    (async ({ paymentCandidate, config, now }: { paymentCandidate: Record<string, unknown>; config: Record<string, unknown>; now: () => Date }) => ({
      paymentProof: paymentCandidate.proof,
      paymentReference:
        (paymentCandidate.paymentReference as string | undefined) ?? `ref_${(paymentCandidate.proof as string).slice(0, 24)}`,
      paymentAmount: config.priceUsd,
      paymentAsset: config.assetSymbol,
      paymentMint: config.mintAddress,
      paymentCluster: config.cluster,
      paymentRecipient: config.recipientAddress,
      paymentTransactionSignature: `sig_${(paymentCandidate.proof as string).slice(0, 24)}`,
      paymentVerifiedAt: now().toISOString(),
      paymentSettledAt: now().toISOString(),
      verificationSource: "test_verifier",
      verificationStatus: "verified",
      paymentResponseHeader: Buffer.from(
        JSON.stringify({ success: true, proof: paymentCandidate.proof }),
        "utf8"
      ).toString("base64")
    }));
  const server = createServer({
    x402PaymentConfig: DEFAULT_X402_PAYMENT_CONFIG,
    verifiedPaymentRepository,
    verifyX402Payment,
    ...options
  } as Parameters<typeof createServer>[0]);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function stopTestServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createReviewerHeaders(token: string = "reviewer-secret") {
  return {
    "x-reviewer-token": token
  };
}

function createPaymentSignatureHeaders(paymentPayload: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "payment-signature": Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64"),
    ...extraHeaders
  };
}

async function createMarketCacheRepository(tempDir: string, markets: Parameters<FileMarketCacheRepository["save"]>[0] = [VALID_MARKET as Parameters<FileMarketCacheRepository["save"]>[0][0]]) {
  const repository = new FileMarketCacheRepository(path.join(tempDir, "market-cache.json"));
  await repository.save(markets);
  return repository;
}

async function createUpcomingMarketCacheRepository(tempDir: string, markets: Parameters<FileMarketCacheRepository["save"]>[0] = [UPCOMING_MARKET as Parameters<FileMarketCacheRepository["save"]>[0][0]]) {
  const repository = new FileMarketCacheRepository(path.join(tempDir, "upcoming-market-cache.json"));
  await repository.save(markets);
  return repository;
}

async function createReviewerScanRepository(tempDir: string) {
  const repository = new FileReviewerScanRepository(path.join(tempDir, "reviewer-scans.json"));
  await repository.save([]);
  return repository;
}

async function createBackgroundJobRepository(tempDir: string) {
  const repository = new FileBackgroundJobRepository(path.join(tempDir, "background-jobs.json"));
  await repository.save([]);
  return repository;
}

async function createTradeActivityRepository(tempDir: string) {
  return new FileTradeActivityRepository(path.join(tempDir, "trade-activity.json"));
}

async function waitFor(assertion: () => Promise<void>, { attempts = 25, delayMs = 10 }: { attempts?: number; delayMs?: number } = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
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
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_001",
        question: "Does Gemini auction data resolve the market?"
      })
    });

    assert.equal(response.status, 402);
    const responseBody = await response.json();
    const paymentRequirements = responseBody.paymentRequirements;
    const encodedPaymentRequired = response.headers.get("payment-required");
    assert.equal(typeof encodedPaymentRequired, "string");
    assert.deepEqual(responseBody, {
      ok: false,
      error: {
        code: "PAYMENT_REQUIRED",
        message: "A verified x402 payment of 1.00 USDC is required before creating a clarification."
      },
      paymentRequirements
    });
    assert.deepEqual(paymentRequirements, [
      {
        feePayer: EXPECTED_PAYMENT_FEE_PAYER,
        x402Version: 2,
        scheme: "exact",
        network: "solana-devnet",
        amount: "1000000",
        maxAmountRequired: "1000000",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        assetSymbol: "USDC",
        description: "Create a clarification request for gm_btc_above_100k.",
        mimeType: "application/json",
        payTo: "11111111111111111111111111111111",
        resource: `${baseUrl}/api/clarify/gm_btc_above_100k`,
        maxTimeoutSeconds: 300,
        extra: {
          cluster: "devnet",
          eventId: "gm_btc_above_100k",
          feePayer: EXPECTED_PAYMENT_FEE_PAYER,
          requesterId: "wallet_001",
          purpose: "clarification_request"
        }
      }
    ]);
    assert.deepEqual(
      JSON.parse(Buffer.from(encodedPaymentRequired!, "base64").toString("utf8")),
      buildX402PaymentRequiredHeader(responseBody)
    );

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
      marketStage: "active",
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
      paymentRecipient: "11111111111111111111111111111111",
      paymentMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      paymentCluster: "devnet",
      paymentTransactionSignature: "sig_pay_proof_001",
      paymentVerificationSource: "test_verifier",
      timing: {
        processingUrgency: "normal",
        processingUrgencyReason: "No elevated urgency signals detected.",
        tradeContextAsOf: null,
        finalityMode: "static",
        finalityWindowSecs: 86400,
        finalityReason: "Static finality window configured at 86400 seconds.",
        marketImportanceScore: null,
        marketImportanceSignals: {}
      },
      createdAt: "2026-03-21T19:05:00.000Z",
      updatedAt: "2026-03-21T19:05:00.000Z",
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

test("POST /api/clarify/:eventId accepts synced upcoming markets and reviewer detail resolves the upcoming cache", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-upcoming-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir, []);
  const upcomingMarketCacheRepository = await createUpcomingMarketCacheRepository(tempDir);

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    upcomingMarketCacheRepository,
    now: () => new Date("2026-03-21T19:05:00.000Z"),
    createClarificationId: () => "clar_upcoming_001",
    reviewerAuthToken: "reviewer-secret",
    runAutomaticClarificationPipeline: async () => {}
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_sol_above_500`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_upcoming_001",
        question: "If trading opens late, does the same expiry still apply?",
        payment: {
          proof: "pay_proof_upcoming_001",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_upcoming_001",
          verified: true
        }
      })
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      clarificationId: "clar_upcoming_001",
      status: "processing"
    });

    const storedClarification = await clarificationRequestRepository.findByClarificationId(
      "clar_upcoming_001"
    );
    assert.equal(storedClarification!.marketStage, "upcoming");

    const reviewerResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_upcoming_001`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(reviewerResponse.status, 200);
    const reviewerPayload = await reviewerResponse.json();
    assert.equal(reviewerPayload.clarification.eventId, "gm_sol_above_500");
    assert.equal(reviewerPayload.clarification.market.marketId, "gm_sol_above_500");
    assert.equal(reviewerPayload.clarification.market.title, UPCOMING_MARKET.title);
    assert.equal(reviewerPayload.clarification.market.status, "approved");
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId accepts PAYMENT-SIGNATURE header proofs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:07:00.000Z"),
    createClarificationId: () => "clar_paid_header_001",
    runAutomaticClarificationPipeline: async () => {}
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: createPaymentSignatureHeaders({
        x402Version: 2,
        scheme: "exact",
        network: "solana-devnet",
        payload: {
          transaction: "tx_001"
        }
      }),
      body: JSON.stringify({
        requesterId: "wallet_header_001",
        question: "Should the clarification intake accept header based x402 proofs?"
      })
    });

    assert.equal(response.status, 202);
    assert.equal(typeof response.headers.get("payment-response"), "string");

    const stored = await repository.findByClarificationId("clar_paid_header_001");
    assert.equal(typeof stored!.paymentProof, "string");
    assert.ok(stored!.paymentProof!.length > 0);
    assert.equal(stored!.paymentReference!.startsWith("ref_"), true);
  } finally {
    await stopTestServer(server);
  }
});

test("clarification creation stores static timing metadata and exposes it in public detail", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-timing-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir, [
    {
      ...VALID_MARKET,
      status: "active",
      volumeUsd: "2500.00",
      liquidityUsd: "1000.00",
      contracts: [{ instrumentSymbol: "GEMI-BTC100K-YES" }]
    }
  ]);
  const tradeActivityRepository = await createTradeActivityRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    tradeActivityRepository,
    clarificationFinalityConfig: {
      mode: "static",
      staticWindowSecs: 86400,
      processingActivityEnabled: false
    },
    now: () => new Date("2026-03-21T19:05:00.000Z"),
    createClarificationId: () => "clar_timing_static_001",
    runAutomaticClarificationPipeline: async () => {}
  });

  try {
    const createResponse = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_timing",
        question: "Should trades during maintenance count?",
        payment: {
          proof: "pay_proof_timing_001",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_timing_001",
          verified: true
        }
      })
    });

    assert.equal(createResponse.status, 202);

    const detailResponse = await fetch(`${baseUrl}/api/clarifications/clar_timing_static_001`);
    assert.equal(detailResponse.status, 200);
    const payload = await detailResponse.json();
    assert.equal(payload.clarification.timing.finalityMode, "static");
    assert.equal(payload.clarification.timing.finalityWindowSecs, 86400);
    assert.equal(payload.clarification.timing.processingUrgency, "normal");
  } finally {
    await stopTestServer(server);
  }
});

test("reviewer clarification detail uses dynamic finality timing from recent trades", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-timing-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir, [
    {
      ...VALID_MARKET,
      status: "active",
      closesAt: "2026-03-21T20:00:00.000Z",
      volumeUsd: "250000.00",
      liquidityUsd: "60000.00",
      contracts: [{ instrumentSymbol: "GEMI-BTC100K-YES" }]
    }
  ]);
  const tradeActivityRepository = await createTradeActivityRepository(tempDir);
  await repository.create({
    clarificationId: "clar_timing_dynamic_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should trades during maintenance count?",
    requesterId: "wallet_dynamic",
    createdAt: "2026-03-21T19:00:00.000Z",
    updatedAt: "2026-03-21T19:10:00.000Z",
    llmOutput: {
      ambiguity_score: 0.9
    }
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    tradeActivityRepository,
    reviewerAuthToken: "reviewer-secret",
    clarificationFinalityConfig: {
      mode: "dynamic",
      staticWindowSecs: 86400,
      processingActivityEnabled: true
    },
    fetchTradesForSymbol: async () => [
      { tid: 10, amount: "6000", timestampms: Date.parse("2026-03-21T19:55:00.000Z") }
    ],
    now: () => new Date("2026-03-21T19:56:00.000Z")
  });

  try {
    const response = await fetch(`${baseUrl}/api/reviewer/clarifications/clar_timing_dynamic_001`, {
      headers: createReviewerHeaders()
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.clarification.timing.finalityMode, "dynamic");
    assert.equal(payload.clarification.timing.finalityWindowSecs, 3600);
    assert.equal(payload.clarification.timing.processingUrgency, "high");
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId returns structured verifier failures without creating clarifications", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:08:00.000Z"),
    createClarificationId: () => "clar_paid_invalid_unused",
    verifyX402Payment: async () => {
      const error = Object.assign(new Error("The supplied x402 payment proof is invalid."), {
        statusCode: 402,
        code: "INVALID_PAYMENT",
        details: {
          invalidReason: "invalid_exact_svm_payload_transaction_amount_mismatch"
        }
      });
      throw error;
    }
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_invalid_001",
        question: "Will mismatched payments be rejected?",
        payment: {
          proof: "pay_proof_invalid_001",
          reference: "x402_ref_invalid_001"
        }
      })
    });

    assert.equal(response.status, 402);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "INVALID_PAYMENT",
        message: "The supplied x402 payment proof is invalid.",
        details: {
          invalidReason: "invalid_exact_svm_payload_transaction_amount_mismatch"
        }
      }
    });
    assert.deepEqual((await repository.load()).requests, []);
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
        message: "Event id must match an active or upcoming synced market before a clarification can be created."
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
    assert.deepEqual((stored.requests as Array<Record<string, unknown>>).map((request) => request.normalizedInput), [
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
    assert.deepEqual(storedRequest!.statusHistory, [
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
    assert.deepEqual(storedRequest!.llmOutput, {
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
    assert.equal(storedRequest!.errorMessage, null);
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
    const storedLlmOutput = storedRequest!.llmOutput as Record<string, unknown>;
    const unauthorizedArtifactResponse = await fetch(
      `${baseUrl}/api/artifacts/${encodeURIComponent(storedRequest!.artifactCid!)}`
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
      `${baseUrl}/api/artifacts/${encodeURIComponent(storedRequest!.artifactCid!)}`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(artifactResponse.status, 200);
    assert.deepEqual(await artifactResponse.json(), {
      ok: true,
      artifact: {
        cid: storedRequest!.artifactCid,
        url: storedRequest!.artifactUrl,
        clarificationId: "clar_paid_artifact_001",
        eventId: "gm_btc_above_100k",
        marketText: VALID_MARKET.resolution,
        suggestedEditedMarketText: storedLlmOutput.suggested_market_text,
        clarificationNote: storedLlmOutput.suggested_note,
        generatedAtUtc: "2026-03-21T19:26:00.000Z",
        publicationProvider: "disabled",
        publicationStatus: "disabled",
        publishedCid: null,
        publishedUrl: null,
        publishedUri: null,
        publishedAt: null,
        publicationError: null
      }
    });

    const detailResponse = await fetch(`${baseUrl}/api/clarifications/clar_paid_artifact_001`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json();
    assert.deepEqual(detailPayload.clarification.llmOutput, storedRequest!.llmOutput);
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
      cid: storedRequest!.artifactCid,
      url: storedRequest!.artifactUrl
    });
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId can wait briefly and return a completed public clarification", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-wait-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:27:00.000Z"),
    createClarificationId: () => "clar_paid_wait_001"
  });

  try {
    const response = await fetch(
      `${baseUrl}/api/clarify/gm_btc_above_100k?wait=true&timeoutMs=2000`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requesterId: "wallet_wait_001",
          question: "Should only the primary Gemini BTC/USD spot feed count?",
          payment: {
            proof: "pay_proof_wait_001",
            amount: "1.00",
            asset: "USDC",
            reference: "x402_ref_wait_001",
            verified: true
          }
        })
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("payment-response") !== null, true);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.clarification.clarificationId, "clar_paid_wait_001");
    assert.equal(payload.clarification.status, "completed");
    assert.equal(payload.clarification.question, "Should only the primary Gemini BTC/USD spot feed count?");
    assert.ok(payload.clarification.llmOutput);
    assert.equal(payload.clarification.artifact, undefined);
  } finally {
    await stopTestServer(server);
  }
});

test("paid clarification pipeline sends the issue clarification skill in the LLM prompt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-prompt-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const originalFetch = globalThis.fetch;
  const llmRequests: Array<{ url: unknown; options: unknown }> = [];
  let nowCallCount = 0;
  const timeline = [
    "2026-03-21T19:29:00.000Z",
    "2026-03-21T19:29:01.000Z",
    "2026-03-21T19:29:02.000Z",
    "2026-03-21T19:29:03.000Z"
  ];

  globalThis.fetch = (async (url: unknown, options: unknown) => {
    if (String(url).startsWith("https://openrouter.test/api/v1/")) {
      llmRequests.push({ url, options });

      return {
        ok: true,
        async json() {
          return {
            model: "openrouter/auto",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: "needs_clarification",
                    llm_status: "completed",
                    reasoning: "The market text does not say whether Gemini auction prints count.",
                    cited_clause: VALID_MARKET.resolution,
                    ambiguity_score: 0.79,
                    ambiguity_summary: "The qualifying Gemini execution rule is not explicit.",
                    suggested_market_text:
                      "Will Gemini BTC/USD spot trade above $100,000 on the primary Gemini BTC/USD continuous order book before December 31 2026 23:59 UTC?",
                    suggested_note:
                      "Exclude auctions and count only the first qualifying continuous-order-book trade."
                  })
                }
              }
            ]
          };
        }
      };
    }

    return originalFetch(url as RequestInfo, options as RequestInit);
  }) as unknown as typeof globalThis.fetch;

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date(timeline[Math.min(nowCallCount++, timeline.length - 1)]),
    createClarificationId: () => "clar_paid_prompt_001",
    llmRuntime: {
      provider: "openrouter",
      apiKey: "openrouter-key",
      model: "openrouter/auto",
      baseUrl: "https://openrouter.test/api/v1"
    }
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_prompt",
        question: "Should Gemini BTC/USD auction prints be excluded?",
        payment: {
          proof: "pay_proof_prompt_001",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_prompt_001",
          verified: true
        }
      })
    });

    assert.equal(response.status, 202);

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_prompt_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "completed");
    });

    assert.equal(llmRequests.length, 1);
    const llmRequestBody = JSON.parse((llmRequests[0] as { options: { body: string } }).options.body);
    assert.match(llmRequestBody.messages[0].content, /# Issue Clarification Response/);
    assert.match(
      llmRequestBody.messages[0].content,
      /Return output with these exact keys/
    );
    assert.match(
      llmRequestBody.messages[0].content,
      /# Gemini Clarification Heuristics/
    );

    const storedRequest = await repository.findByClarificationId("clar_paid_prompt_001");
    assert.equal((storedRequest!.llmTrace as Record<string, unknown>).promptTemplateVersion, "issue-clarification-response-v1");
  } finally {
    globalThis.fetch = originalFetch;
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId returns 202 when wait window expires before completion", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-wait-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:28:00.000Z"),
    createClarificationId: () => "clar_paid_wait_timeout_001",
    runAutomaticClarificationPipeline: async (...args: unknown[]) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      const { runAutomaticClarificationPipeline } = await import(
        "../src/automatic-llm-pipeline.js"
      );

      return runAutomaticClarificationPipeline(args[0] as Parameters<typeof runAutomaticClarificationPipeline>[0]);
    }
  });

  try {
    const response = await fetch(
      `${baseUrl}/api/clarify/gm_btc_above_100k?wait=true&timeoutMs=1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requesterId: "wallet_wait_timeout_001",
          question: "Should only the primary Gemini BTC/USD spot feed count?",
          payment: {
            proof: "pay_proof_wait_timeout_001",
            amount: "1.00",
            asset: "USDC",
            reference: "x402_ref_wait_timeout_001",
            verified: true
          }
        })
      }
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      clarificationId: "clar_paid_wait_timeout_001",
      status: "processing"
    });

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_wait_timeout_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "completed");
    });
  } finally {
    await stopTestServer(server);
  }
});

test("pipeline stores publication metadata without exposing artifact metadata publicly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-publish-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const artifactRepository = new FileArtifactRepository(path.join(tempDir, "artifacts.json"));
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    artifactRepository,
    artifactPublisher: {
      provider: "ipfs",
      async publishArtifact() {
        return {
          publicationProvider: "ipfs",
          publicationStatus: "published",
          publishedCid: "bafyrealipfscid001",
          publishedUrl: "https://gateway.example/ipfs/bafyrealipfscid001",
          publishedUri: "ipfs://bafyrealipfscid001",
          publishedAt: "2026-03-21T19:29:02.000Z",
          publicationError: null
        };
      }
    },
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:29:00.000Z"),
    createClarificationId: () => "clar_paid_publish_001",
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const response = await fetch(`${baseUrl}/api/clarify/gm_btc_above_100k`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requesterId: "wallet_publish_001",
        question: "Should only the primary Gemini BTC/USD spot feed count?",
        payment: {
          proof: "pay_proof_publish_001",
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_publish_001",
          verified: true
        }
      })
    });

    assert.equal(response.status, 202);

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_publish_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "completed");
      assert.equal(storedRequest.artifactPublicationProvider, "ipfs");
      assert.equal(storedRequest.artifactPublicationStatus, "published");
      assert.equal(storedRequest.artifactPublishedCid, "bafyrealipfscid001");
      assert.equal(storedRequest.artifactPublishedUri, "ipfs://bafyrealipfscid001");
    });

    const storedRequest = await repository.findByClarificationId("clar_paid_publish_001");
    const storedArtifact = await artifactRepository.findByCid(storedRequest!.artifactCid as string);

    assert.ok(storedArtifact);
    assert.equal((storedArtifact as Record<string, unknown>).publicationProvider, "ipfs");
    assert.equal((storedArtifact as Record<string, unknown>).publicationStatus, "published");
    assert.equal((storedArtifact as Record<string, unknown>).publishedCid, "bafyrealipfscid001");
    assert.equal((storedArtifact as Record<string, unknown>).publishedUrl, "https://gateway.example/ipfs/bafyrealipfscid001");

    const detailResponse = await fetch(`${baseUrl}/api/clarifications/clar_paid_publish_001`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.clarification.artifact, undefined);
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
        requestedAt: "2026-03-21T19:27:03.000Z",
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
        createdAt: "2026-03-21T19:27:02.000Z",
        updatedAt: "2026-03-21T19:27:03.000Z",
        llmOutput: {
          verdict: "needs_clarification",
          llm_status: "completed",
          reasoning:
            "The market text depends on Gemini BTC/USD spot prints but leaves room for ambiguity around which Gemini price feed or session record is authoritative.",
          cited_clause: VALID_MARKET.resolution,
          ambiguity_score: 0.72,
          ambiguity_summary:
            "The resolution source is named at a high level, but the exact qualifying Gemini print is not explicit.",
          suggested_market_text:
            "Will Gemini BTC/USD spot trade above $100,000 on the primary Gemini exchange feed before December 31 2026 23:59 UTC?",
          suggested_note:
            "Use Gemini's primary BTC/USD spot exchange feed and count the first eligible trade print above $100,000 before expiry."
        },
        timing: {
          processingUrgency: "normal",
          processingUrgencyReason: "No elevated urgency signals detected.",
          tradeContextAsOf: null,
          finalityMode: "static",
          finalityWindowSecs: 86400,
          finalityReason: "Static finality window configured at 86400 seconds.",
          marketImportanceScore: null,
          marketImportanceSignals: {}
        }
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
          requestedAt: "2026-03-21T19:27:03.000Z",
          processingVersion: "offchain-pipeline-2026-03-21"
        },
        timing: {
          processingUrgency: "normal",
          processingUrgencyReason: "No elevated urgency signals detected.",
          tradeContextAsOf: null,
          finalityMode: "static",
          finalityWindowSecs: 86400,
          finalityReason: "Static finality window configured at 86400 seconds.",
          marketImportanceScore: null,
          marketImportanceSignals: {}
        },
        market: {
          marketId: "gm_btc_above_100k",
          title: VALID_MARKET.title,
          resolutionText: VALID_MARKET.resolution,
          endTime: VALID_MARKET.closesAt,
          slug: VALID_MARKET.slug,
          url: VALID_MARKET.url
        },
        funding: {
          raisedAmount: "1.00",
          targetAmount: "1.00",
          contributorCount: 1,
          fundingState: "funded",
          history: [
            {
              contributor: "wallet_trace_1",
              amount: "1.00",
              timestamp: "2026-03-21T19:27:00.000Z",
              reference: "x402_ref_trace_001"
            }
          ]
        },
        vote: {
          status: "not_started",
          label: "Not Started",
          placeholder: true,
          summary: "Off-chain placeholder until panel voting is implemented.",
          updatedAt: "2026-03-21T19:27:03.000Z"
        },
        createdAt: "2026-03-21T19:27:02.000Z",
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
        requestedAt: "2026-03-21T19:28:03.000Z",
        processingVersion: "offchain-pipeline-2026-03-22"
      });
    });

    const firstStoredRequest = await repository.findByClarificationId("clar_paid_trace_001");
    assert.deepEqual(firstStoredRequest!.llmTrace, {
      promptTemplateVersion: "prompt-v1",
      modelId: "gemini-reviewer-001",
      requestedAt: "2026-03-21T19:27:03.000Z",
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

test("reviewer-only artifact routes reject incorrect reviewer tokens", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const artifactRepository = new FileArtifactRepository(path.join(tempDir, "artifacts.json"));
  const marketCacheRepository = await createMarketCacheRepository(tempDir);

  await repository.create({
    clarificationId: "clar_reviewer_artifact_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should only Gemini spot prints count?",
    llmOutput: {
      ambiguity_score: 0.61
    },
    artifactCid: "bafyreviewerartifact001",
    artifactUrl: "ipfs://bafyreviewerartifact001",
    createdAt: "2026-03-21T19:29:30.000Z",
    updatedAt: "2026-03-21T19:29:30.000Z"
  });
  const artifact = await artifactRepository.createArtifact({
    clarificationId: "clar_reviewer_artifact_001",
    eventId: "gm_btc_above_100k",
    marketText: VALID_MARKET.resolution,
    suggestedEditedMarketText: "Use Gemini BTC/USD spot prints only.",
    clarificationNote: "Reviewer-only artifact payload",
    generatedAtUtc: "2026-03-21T19:29:30.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    artifactRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:29:30.000Z"),
    createClarificationId: () => "unused",
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const response = await fetch(`${baseUrl}/api/artifacts/${artifact.cid}`, {
      headers: createReviewerHeaders("wrong-reviewer-secret")
    });

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

test("GET /api/reviewer/clarifications/:clarificationId returns reviewer detail fields for market text, funding history, artifact references, and vote placeholders", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-detail-ui-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);

  await clarificationRequestRepository.create({
    clarificationId: "clar_detail_seed_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Do auction prints count for funding history?",
    requesterId: "wallet_seed_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_seed_001",
    paymentProof: "pay_proof_seed_001",
    paymentVerifiedAt: "2026-03-21T20:31:00.000Z",
    createdAt: "2026-03-21T20:31:00.000Z",
    updatedAt: "2026-03-21T20:31:00.000Z"
  });
  await clarificationRequestRepository.create({
    clarificationId: "clar_detail_target_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    reviewerWorkflowStatus: "awaiting_panel_vote",
    eventId: "gm_btc_above_100k",
    question: "Should only Gemini BTC/USD spot trades count?",
    requesterId: "wallet_target_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_target_001",
    paymentProof: "pay_proof_target_001",
    paymentVerifiedAt: "2026-03-21T20:35:00.000Z",
    llmOutput: {
      verdict: "needs_clarification",
      llm_status: "completed",
      reasoning: "The resolution text names Gemini but not the exact qualifying feed.",
      cited_clause: VALID_MARKET.resolution,
      ambiguity_score: 0.79,
      ambiguity_summary: "The qualifying Gemini price source is not explicit.",
      suggested_market_text:
        "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC?",
      suggested_note:
        "Use Gemini's primary BTC/USD spot exchange feed and ignore non-spot auction references."
    },
    artifactCid: "bafydetailartifact001",
    artifactUrl: "ipfs://bafydetailartifact001",
    createdAt: "2026-03-21T20:35:00.000Z",
    updatedAt: "2026-03-21T20:40:00.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T20:40:00.000Z"),
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const response = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_detail_target_001`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      clarification: {
        clarificationId: "clar_detail_target_001",
        status: "completed",
        eventId: "gm_btc_above_100k",
        question: "Should only Gemini BTC/USD spot trades count?",
        llmOutput: {
          verdict: "needs_clarification",
          llm_status: "completed",
          reasoning: "The resolution text names Gemini but not the exact qualifying feed.",
          cited_clause: VALID_MARKET.resolution,
          ambiguity_score: 0.79,
          ambiguity_summary: "The qualifying Gemini price source is not explicit.",
          suggested_market_text:
            "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC?",
          suggested_note:
            "Use Gemini's primary BTC/USD spot exchange feed and ignore non-spot auction references."
        },
        llmTrace: null,
        artifact: {
          cid: "bafydetailartifact001",
          url: "ipfs://bafydetailartifact001"
        },
        market: {
          marketId: "gm_btc_above_100k",
          title: VALID_MARKET.title,
          resolutionText: VALID_MARKET.resolution,
          endTime: VALID_MARKET.closesAt,
          slug: VALID_MARKET.slug,
          url: VALID_MARKET.url
        },
        funding: {
          raisedAmount: "2.00",
          targetAmount: "1.00",
          contributorCount: 2,
          fundingState: "funded",
          history: [
            {
              contributor: "wallet_target_001",
              amount: "1.00",
              timestamp: "2026-03-21T20:35:00.000Z",
              reference: "x402_ref_target_001"
            },
            {
              contributor: "wallet_seed_001",
              amount: "1.00",
              timestamp: "2026-03-21T20:31:00.000Z",
              reference: "x402_ref_seed_001"
            }
          ]
        },
        vote: {
          status: "awaiting_panel_vote",
          label: "Awaiting Panel Vote",
          placeholder: true,
          summary: "Off-chain placeholder until panel voting is implemented.",
          updatedAt: "2026-03-21T20:40:00.000Z"
        },
        timing: {
          processingUrgency: "normal",
          processingUrgencyReason: "No elevated urgency signals detected.",
          tradeContextAsOf: null,
          finalityMode: "static",
          finalityWindowSecs: 86400,
          finalityReason: "Static finality window configured at 86400 seconds.",
          marketImportanceScore: null,
          marketImportanceSignals: {}
        },
        createdAt: "2026-03-21T20:35:00.000Z",
        updatedAt: "2026-03-21T20:40:00.000Z",
        review_window_secs: 86400,
        review_window_reason:
          "Base window set from gt_72h time-to-end bucket. Final window 86400 seconds within 3600-86400 second policy bounds.",
        time_to_end_bucket: "gt_72h",
        activity_signal: "normal",
        ambiguity_score: 0.79
      }
    });
  } finally {
    await stopTestServer(server);
  }
});

test("GET /api/reviewer/clarifications/:clarificationId/funding returns a per-clarification funding read model and contribution history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-funding-status-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  await clarificationRequestRepository.create({
    clarificationId: "clar_funding_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should reviewer funding history stay attached to one clarification?",
    requesterId: "wallet_funding_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_funding_001",
    paymentProof: "pay_proof_funding_001",
    paymentVerifiedAt: "2026-03-21T20:55:00.000Z",
    createdAt: "2026-03-21T20:55:00.000Z",
    updatedAt: "2026-03-21T20:55:00.000Z"
  });

  let nowCallCount = 0;
  const timestamps = ["2026-03-21T21:00:00.000Z", "2026-03-21T21:05:00.000Z"];
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    now: () => new Date(timestamps[Math.min(nowCallCount++, timestamps.length - 1)]),
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const emptyFundingResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_funding_001/funding`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(emptyFundingResponse.status, 200);
    assert.deepEqual(await emptyFundingResponse.json(), {
      ok: true,
      funding: {
        targetAmount: "1.00",
        raisedAmount: "0.00",
        contributorCount: 0,
        fundingState: "unfunded",
        history: []
      }
    });

    const firstContributionResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_funding_001/funding/contributions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createReviewerHeaders()
        },
        body: JSON.stringify({
          contributor: "desk.alpha",
          amount: "0.40"
        })
      }
    );

    assert.equal(firstContributionResponse.status, 201);
    assert.deepEqual(await firstContributionResponse.json(), {
      ok: true,
      funding: {
        targetAmount: "1.00",
        raisedAmount: "0.40",
        contributorCount: 1,
        fundingState: "funding_in_progress",
        history: [
          {
            contributor: "desk.alpha",
            amount: "0.40",
            timestamp: "2026-03-21T21:00:00.000Z",
            reference: null
          }
        ]
      }
    });

    const secondContributionResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_funding_001/funding/contributions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createReviewerHeaders()
        },
        body: JSON.stringify({
          contributor: "desk.beta",
          amount: "0.60",
          reference: "contribution_beta_001"
        })
      }
    );

    assert.equal(secondContributionResponse.status, 201);
    assert.deepEqual(await secondContributionResponse.json(), {
      ok: true,
      funding: {
        targetAmount: "1.00",
        raisedAmount: "1.00",
        contributorCount: 2,
        fundingState: "funded",
        history: [
          {
            contributor: "desk.beta",
            amount: "0.60",
            timestamp: "2026-03-21T21:05:00.000Z",
            reference: "contribution_beta_001"
          },
          {
            contributor: "desk.alpha",
            amount: "0.40",
            timestamp: "2026-03-21T21:00:00.000Z",
            reference: null
          }
        ]
      }
    });

    const detailResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_funding_001`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(detailResponse.status, 200);
    assert.deepEqual((await detailResponse.json()).clarification.funding, {
      targetAmount: "1.00",
      raisedAmount: "1.00",
      contributorCount: 2,
      fundingState: "funded",
      history: [
        {
          contributor: "desk.beta",
          amount: "0.60",
          timestamp: "2026-03-21T21:05:00.000Z",
          reference: "contribution_beta_001"
        },
        {
          contributor: "desk.alpha",
          amount: "0.40",
          timestamp: "2026-03-21T21:00:00.000Z",
          reference: null
        }
      ]
    });

    const missingResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_missing_404/funding`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), {
      ok: false,
      error: {
        code: "CLARIFICATION_NOT_FOUND",
        message: "Clarification not found."
      }
    });
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/reviewer/clarifications/:clarificationId/funding/contributions is idempotent by contribution reference and preserves structured 4xx/5xx errors", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-funding-idempotency-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);

  await clarificationRequestRepository.create({
    clarificationId: "clar_funding_idempotent_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should replayed contribution references be deduplicated?",
    requesterId: "wallet_funding_dedupe_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_funding_dedupe_001",
    paymentProof: "pay_proof_funding_dedupe_001",
    paymentVerifiedAt: "2026-03-21T21:08:00.000Z",
    createdAt: "2026-03-21T21:08:00.000Z",
    updatedAt: "2026-03-21T21:08:00.000Z"
  });

  const contributionPath =
    "/api/reviewer/clarifications/clar_funding_idempotent_001/funding/contributions";
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T21:10:00.000Z"),
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const firstContributionResponse = await fetch(`${baseUrl}${contributionPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createReviewerHeaders()
      },
      body: JSON.stringify({
        contributor: "desk.gamma",
        amount: "0.55",
        reference: "contribution_gamma_001"
      })
    });

    assert.equal(firstContributionResponse.status, 201);
    assert.deepEqual(await firstContributionResponse.json(), {
      ok: true,
      funding: {
        targetAmount: "1.00",
        raisedAmount: "0.55",
        contributorCount: 1,
        fundingState: "funding_in_progress",
        history: [
          {
            contributor: "desk.gamma",
            amount: "0.55",
            timestamp: "2026-03-21T21:10:00.000Z",
            reference: "contribution_gamma_001"
          }
        ]
      }
    });

    const replayContributionResponse = await fetch(`${baseUrl}${contributionPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createReviewerHeaders()
      },
      body: JSON.stringify({
        contributor: "desk.gamma",
        amount: "0.55",
        reference: "contribution_gamma_001"
      })
    });

    assert.equal(replayContributionResponse.status, 200);
    assert.deepEqual(await replayContributionResponse.json(), {
      ok: true,
      funding: {
        targetAmount: "1.00",
        raisedAmount: "0.55",
        contributorCount: 1,
        fundingState: "funding_in_progress",
        history: [
          {
            contributor: "desk.gamma",
            amount: "0.55",
            timestamp: "2026-03-21T21:10:00.000Z",
            reference: "contribution_gamma_001"
          }
        ]
      }
    });

    const storedClarification =
      await clarificationRequestRepository.findByClarificationId("clar_funding_idempotent_001");
    assert.deepEqual((storedClarification!.funding as Record<string, unknown>).history, [
      {
        contributor: "desk.gamma",
        amount: "0.55",
        timestamp: "2026-03-21T21:10:00.000Z",
        reference: "contribution_gamma_001"
      }
    ]);

    const validationFailureResponse = await fetch(`${baseUrl}${contributionPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createReviewerHeaders()
      },
      body: JSON.stringify({
        contributor: "desk.gamma",
        amount: "0"
      })
    });

    assert.equal(validationFailureResponse.status, 400);
    assert.deepEqual(await validationFailureResponse.json(), {
      ok: false,
      error: {
        code: "INVALID_FUNDING_AMOUNT",
        message: "Funding amount must be a positive decimal string."
      }
    });

    const failingRepository = {
      ...clarificationRequestRepository,
      async findByClarificationId(clarificationId: string) {
        return clarificationRequestRepository.findByClarificationId(clarificationId);
      },
      async updateByClarificationId() {
        throw new Error("disk write failed");
      }
    } as unknown as typeof clarificationRequestRepository;
    const failingServer = await startTestServer({
      clarificationRequestRepository: failingRepository,
      marketCacheRepository,
      now: () => new Date("2026-03-21T21:15:00.000Z"),
      reviewerAuthToken: "reviewer-secret"
    });

    try {
      const internalFailureResponse = await fetch(
        `${failingServer.baseUrl}${contributionPath}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...createReviewerHeaders()
          },
          body: JSON.stringify({
            contributor: "desk.delta",
            amount: "0.25",
            reference: "contribution_delta_001"
          })
        }
      );

      assert.equal(internalFailureResponse.status, 500);
      assert.deepEqual(await internalFailureResponse.json(), {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred."
        }
      });
    } finally {
      await stopTestServer(failingServer.server);
    }
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/reviewer/clarifications/:clarificationId/awaiting-panel-vote stores placeholder vote workflow status without chain integration", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-vote-placeholder-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  const reviewerScanRepository = await createReviewerScanRepository(tempDir);

  await clarificationRequestRepository.create({
    clarificationId: "clar_vote_placeholder_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should the reviewer panel vote before final text is locked?",
    requesterId: "wallet_vote_placeholder_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_vote_placeholder_001",
    paymentProof: "pay_proof_vote_placeholder_001",
    paymentVerifiedAt: "2026-03-21T20:50:00.000Z",
    llmOutput: {
      verdict: "needs_clarification",
      llm_status: "completed",
      reasoning: "The market text needs a decision on whether auction prints qualify.",
      cited_clause: VALID_MARKET.resolution,
      ambiguity_score: 0.76,
      ambiguity_summary: "Auction-print handling is ambiguous.",
      suggested_market_text:
        "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC?",
      suggested_note:
        "Use Gemini's primary BTC/USD spot exchange feed and exclude auction-only prints."
    },
    createdAt: "2026-03-21T20:50:00.000Z",
    updatedAt: "2026-03-21T20:55:00.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    reviewerScanRepository,
    now: () => new Date("2026-03-21T21:00:00.000Z"),
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const transitionResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_vote_placeholder_001/awaiting-panel-vote`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createReviewerHeaders()
        },
        body: JSON.stringify({
          reviewerId: "reviewer.casey"
        })
      }
    );

    assert.equal(transitionResponse.status, 200);
    assert.deepEqual(await transitionResponse.json(), {
      ok: true,
      clarification: {
        clarificationId: "clar_vote_placeholder_001",
        reviewerWorkflowStatus: "awaiting_panel_vote",
        vote: {
          status: "awaiting_panel_vote",
          label: "Awaiting Panel Vote",
          placeholder: true,
          summary: "Off-chain placeholder until panel voting is implemented.",
          updatedAt: "2026-03-21T21:00:00.000Z"
        }
      }
    });

    const storedClarification =
      await clarificationRequestRepository.findByClarificationId("clar_vote_placeholder_001");
    assert.equal(storedClarification!.reviewerWorkflowStatus, "awaiting_panel_vote");
    assert.deepEqual(storedClarification!.reviewerActions, [
      {
        type: "marked_awaiting_panel_vote",
        actor: "reviewer.casey",
        timestamp: "2026-03-21T21:00:00.000Z",
        previousReviewerWorkflowStatus: "not_started"
      }
    ]);

    const detailResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_vote_placeholder_001`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(detailResponse.status, 200);
    assert.equal(
      (await detailResponse.json()).clarification.vote.status,
      "awaiting_panel_vote"
    );

    const queueResponse = await fetch(
      `${baseUrl}/api/reviewer/queue?filter=awaiting_panel_vote`,
      {
        headers: createReviewerHeaders()
      }
    );
    assert.equal(queueResponse.status, 200);
    assert.deepEqual((await queueResponse.json()).queue, [
      {
        eventId: "gm_btc_above_100k",
        latestClarificationId: "clar_vote_placeholder_001",
        marketTitle: VALID_MARKET.title,
        endTime: VALID_MARKET.closesAt,
        ambiguityScore: null,
        fundingProgress: {
          raisedAmount: "1.00",
          targetAmount: "1.00",
          contributorCount: 1,
          fundingState: "funded"
        },
        reviewWindow: {
          review_window_secs: 86400,
          review_window_reason:
            "Base window set from gt_72h time-to-end bucket. Final window 86400 seconds within 3600-86400 second policy bounds.",
          time_to_end_bucket: "gt_72h",
          activity_signal: "normal",
          ambiguity_score: 0
        },
        voteStatus: "awaiting_panel_vote",
        queueStates: ["needs_scan", "funded", "awaiting_panel_vote"]
      }
    ]);
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/reviewer/clarifications/:clarificationId/finalize stores off-chain finalization data and exposes finalized reviewer detail", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-finalization-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  await clarificationRequestRepository.create({
    clarificationId: "clar_finalize_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should Gemini BTC/USD auction prints count toward resolution?",
    requesterId: "wallet_finalize_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_finalize_001",
    paymentProof: "pay_proof_finalize_001",
    paymentVerifiedAt: "2026-03-21T21:00:00.000Z",
    reviewerWorkflowStatus: "awaiting_panel_vote",
    llmOutput: {
      verdict: "needs_clarification",
      llm_status: "completed",
      reasoning: "The market text does not specify whether Gemini auction prints qualify.",
      cited_clause: VALID_MARKET.resolution,
      ambiguity_score: 0.81,
      ambiguity_summary: "Gemini price source handling is ambiguous.",
      suggested_market_text:
        "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC?",
      suggested_note:
        "Use Gemini's primary BTC/USD spot exchange feed and exclude auction-only prints."
    },
    createdAt: "2026-03-21T21:00:00.000Z",
    updatedAt: "2026-03-21T21:05:00.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T21:10:00.000Z"),
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const finalizeResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_finalize_001/finalize`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createReviewerHeaders()
        },
        body: JSON.stringify({
          finalEditedText:
            "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
          finalNote:
            "Resolve only from Gemini's primary BTC/USD spot feed; do not count auction prints.",
          reviewerId: "reviewer.alex"
        })
      }
    );

    assert.equal(finalizeResponse.status, 200);
    assert.deepEqual(await finalizeResponse.json(), {
      ok: true,
      clarification: {
        clarificationId: "clar_finalize_001",
        reviewerWorkflowStatus: "finalized",
        finalization: {
          finalEditedText:
            "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
          finalNote:
            "Resolve only from Gemini's primary BTC/USD spot feed; do not count auction prints.",
          finalizedAt: "2026-03-21T21:10:00.000Z",
          finalizedBy: "reviewer.alex"
        }
      }
    });

    const storedClarification =
      await clarificationRequestRepository.findByClarificationId("clar_finalize_001");
    assert.equal(storedClarification!.reviewerWorkflowStatus, "finalized");
    assert.equal(
      storedClarification!.finalEditedText,
      "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?"
    );
    assert.equal(
      storedClarification!.finalNote,
      "Resolve only from Gemini's primary BTC/USD spot feed; do not count auction prints."
    );
    assert.equal(storedClarification!.finalizedAt, "2026-03-21T21:10:00.000Z");
    assert.equal(storedClarification!.finalizedBy, "reviewer.alex");
    assert.equal(
      (storedClarification!.llmOutput as Record<string, unknown>).suggested_market_text,
      "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC?"
    );
    assert.deepEqual(storedClarification!.reviewerActions, [
      {
        type: "finalized",
        actor: "reviewer.alex",
        timestamp: "2026-03-21T21:10:00.000Z",
        previousReviewerWorkflowStatus: "awaiting_panel_vote",
        finalEditedText:
          "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
        finalNote:
          "Resolve only from Gemini's primary BTC/USD spot feed; do not count auction prints."
      }
    ]);

    const reviewerDetailResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_finalize_001`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(reviewerDetailResponse.status, 200);
    assert.deepEqual((await reviewerDetailResponse.json()).clarification.finalization, {
      finalEditedText:
        "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
      finalNote:
        "Resolve only from Gemini's primary BTC/USD spot feed; do not count auction prints.",
      finalizedAt: "2026-03-21T21:10:00.000Z",
      finalizedBy: "reviewer.alex"
    });
    assert.equal(
      ((await clarificationRequestRepository.findByClarificationId("clar_finalize_001"))!
        .llmOutput as Record<string, unknown>).suggested_note,
      "Use Gemini's primary BTC/USD spot exchange feed and exclude auction-only prints."
    );
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/clarify/:eventId enqueues a retryable interpretation job and retry does not duplicate side effects", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paid-clarification-"));
  const repository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const backgroundJobRepository = await createBackgroundJobRepository(tempDir);
  const artifactRepository = new FileArtifactRepository(path.join(tempDir, "artifacts.json"));
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  let shouldFail = true;
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository: repository,
    backgroundJobRepository,
    artifactRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T19:30:00.000Z"),
    createClarificationId: () => "clar_paid_pipeline_fail_001",
    createBackgroundJobId: () => "job_clarification_001",
    reviewerAuthToken: "reviewer-secret",
    runAutomaticClarificationPipeline: async (...args: unknown[]) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("LLM provider timeout");
      }

      const { runAutomaticClarificationPipeline } = await import(
        "../src/automatic-llm-pipeline.js"
      );

      return runAutomaticClarificationPipeline(args[0] as Parameters<typeof runAutomaticClarificationPipeline>[0]);
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
      status: "processing",
      job: {
        jobId: "job_clarification_001",
        kind: "clarification_pipeline",
        status: "processing",
        attempts: 1,
        retryable: false,
        target: {
          clarificationId: "clar_paid_pipeline_fail_001",
          eventId: "gm_btc_above_100k",
          marketStage: "active"
        }
      }
    });

    await waitFor(async () => {
      const storedRequest = await repository.findByClarificationId("clar_paid_pipeline_fail_001");
      assert.ok(storedRequest);
      assert.equal(storedRequest.status, "failed");
    });

    const failedJob = await backgroundJobRepository.findByJobId("job_clarification_001");
    assert.deepEqual(failedJob, {
      jobId: "job_clarification_001",
      kind: "clarification_pipeline",
      status: "failed",
      createdAt: "2026-03-21T19:30:00.000Z",
      updatedAt: "2026-03-21T19:30:00.000Z",
      attempts: 1,
      retryable: true,
      target: {
        clarificationId: "clar_paid_pipeline_fail_001",
        eventId: "gm_btc_above_100k",
        marketStage: "active"
      },
      errorMessage: "LLM provider timeout",
      result: null
    });

    const storedRequest = await repository.findByClarificationId("clar_paid_pipeline_fail_001");
    assert.equal(storedRequest!.errorMessage, "LLM provider timeout");
    assert.equal(storedRequest!.retryable, true);
    assert.equal(storedRequest!.llmOutput, null);
    assert.deepEqual(storedRequest!.statusHistory, [
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

    const retryResponse = await fetch(
      `${baseUrl}/api/reviewer/jobs/job_clarification_001/retry`,
      {
        method: "POST",
        headers: createReviewerHeaders()
      }
    );

    assert.equal(retryResponse.status, 202);
    assert.deepEqual(await retryResponse.json(), {
      ok: true,
      job: {
        jobId: "job_clarification_001",
        kind: "clarification_pipeline",
        status: "processing",
        attempts: 2,
        retryable: true,
        target: {
          clarificationId: "clar_paid_pipeline_fail_001",
          eventId: "gm_btc_above_100k",
          marketStage: "active"
        }
      }
    });

    await waitFor(async () => {
      const retriedRequest = await repository.findByClarificationId("clar_paid_pipeline_fail_001");
      assert.ok(retriedRequest);
      assert.equal(retriedRequest.status, "completed");
      assert.match(retriedRequest.artifactCid ?? "", /^bafy[a-z0-9]+$/);
    });

    const retriedJob = await backgroundJobRepository.findByJobId("job_clarification_001");
    assert.deepEqual(retriedJob, {
      jobId: "job_clarification_001",
      kind: "clarification_pipeline",
      status: "completed",
      createdAt: "2026-03-21T19:30:00.000Z",
      updatedAt: "2026-03-21T19:30:00.000Z",
      attempts: 2,
      retryable: false,
      target: {
        clarificationId: "clar_paid_pipeline_fail_001",
        eventId: "gm_btc_above_100k",
        marketStage: "active"
      },
      errorMessage: null,
      result: {
        clarificationId: "clar_paid_pipeline_fail_001",
        artifactCid: (
          await repository.findByClarificationId("clar_paid_pipeline_fail_001")
        )!.artifactCid
      }
    });

    const allClarifications = await repository.list();
    assert.equal(allClarifications.length, 1);
    const artifacts = await artifactRepository.load();
    assert.equal(artifacts.artifacts.length, 1);
  } finally {
    await stopTestServer(server);
  }
});

test("GET /api/reviewer/queue and reviewer scan endpoints persist scan outputs for active markets", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-queue-scan-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const backgroundJobRepository = await createBackgroundJobRepository(tempDir);
  const reviewerScanRepository = await createReviewerScanRepository(tempDir);
  const marketCacheRepository = await createMarketCacheRepository(tempDir, [
    VALID_MARKET,
    {
      marketId: "gm_eth_above_5000",
      title: "Will ETH trade above $5,000 before year end?",
      resolution:
        "Resolves YES if Gemini ETH/USD prints above $5,000 before December 31 2026 23:59 UTC.",
      closesAt: "2026-03-21T23:00:00.000Z",
      slug: "eth-above-5000-2026",
      url: "https://example.com/markets/eth-above-5000-2026",
      lastSyncedAt: "2026-03-21T18:59:00.000Z",
      activitySignal: "high"
    }
  ]);
  let nowCallCount = 0;
  const timeline = [
    "2026-03-21T19:40:00.000Z",
    "2026-03-21T19:45:00.000Z",
    "2026-03-21T19:50:00.000Z"
  ];
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    backgroundJobRepository,
    reviewerScanRepository,
    marketCacheRepository,
    now: () => new Date(timeline[Math.min(nowCallCount++, timeline.length - 1)]),
    reviewerAuthToken: "reviewer-secret",
    createBackgroundJobId: (() => {
      let nextJob = 1;
      return () => `job_scan_${String(nextJob++).padStart(3, "0")}`;
    })()
  });

  try {
    const singleScanResponse = await fetch(
      `${baseUrl}/api/reviewer/scan/gm_btc_above_100k`,
      {
        method: "POST",
        headers: createReviewerHeaders()
      }
    );

    assert.equal(singleScanResponse.status, 202);
    assert.deepEqual(await singleScanResponse.json(), {
      ok: true,
      job: {
        jobId: "job_scan_001",
        kind: "reviewer_scan",
        status: "processing",
        attempts: 1,
        retryable: false,
        target: {
          eventId: "gm_btc_above_100k"
        }
      }
    });

    await waitFor(async () => {
      const storedScan = await reviewerScanRepository.findLatestByEventId("gm_btc_above_100k");
      assert.ok(storedScan);
      assert.equal(storedScan.jobId, "job_scan_001");
    });

    const singleScanJob = await backgroundJobRepository.findByJobId("job_scan_001");
    assert.ok(singleScanJob);
    assert.equal(singleScanJob.jobId, "job_scan_001");
    assert.equal(singleScanJob.kind, "reviewer_scan");
    assert.equal(singleScanJob.status, "completed");
    assert.equal(singleScanJob.createdAt, "2026-03-21T19:40:00.000Z");
    assert.equal(singleScanJob.attempts, 1);
    assert.equal(singleScanJob.retryable, false);
    assert.deepEqual(singleScanJob.target, {
      eventId: "gm_btc_above_100k"
    });
    assert.equal(singleScanJob.errorMessage, null);
    assert.match(singleScanJob.updatedAt as string, /^2026-03-21T19:(45|50):00.000Z$/);
    assert.match((singleScanJob.result as Record<string, string>).scanId, /^scan_gm_btc_above_100k_2026-03-21T19:/);

    const queueResponse = await fetch(`${baseUrl}/api/reviewer/queue`, {
      headers: createReviewerHeaders()
    });

    assert.equal(queueResponse.status, 200);
    assert.deepEqual(await queueResponse.json(), {
      ok: true,
      availableCategories: [],
      filters: [
        {
          key: "needs_scan",
          label: "Needs Scan",
          count: 1
        },
        {
          key: "high_ambiguity",
          label: "High Ambiguity",
          count: 1
        },
        {
          key: "funded",
          label: "Funded",
          count: 0
        },
        {
          key: "near_expiry",
          label: "Near Expiry",
          count: 1
        },
        {
          key: "awaiting_panel_vote",
          label: "Awaiting Panel Vote",
          count: 0
        },
        {
          key: "finalized",
          label: "Finalized",
          count: 0
        }
      ],
      queue: [
        {
          eventId: "gm_btc_above_100k",
          latestClarificationId: null,
          marketTitle: VALID_MARKET.title,
          endTime: VALID_MARKET.closesAt,
          ambiguityScore: 0.72,
          fundingProgress: {
            raisedAmount: "0.00",
            targetAmount: "1.00",
            contributorCount: 0,
            fundingState: "unfunded"
          },
          reviewWindow: {
            review_window_secs: 86400,
            review_window_reason:
              "Base window set from gt_72h time-to-end bucket. Final window 86400 seconds within 3600-86400 second policy bounds.",
            time_to_end_bucket: "gt_72h",
            activity_signal: "normal",
            ambiguity_score: 0.72
          },
          voteStatus: "not_started",
          queueStates: ["high_ambiguity"]
        },
        {
          eventId: "gm_eth_above_5000",
          latestClarificationId: null,
          marketTitle: "Will ETH trade above $5,000 before year end?",
          endTime: "2026-03-21T23:00:00.000Z",
          ambiguityScore: null,
          fundingProgress: {
            raisedAmount: "0.00",
            targetAmount: "1.00",
            contributorCount: 0,
            fundingState: "unfunded"
          },
          reviewWindow: {
            review_window_secs: 3600,
            review_window_reason:
              "Base window set from lt_6h time-to-end bucket. High activity reduced the review window by one policy step. Final window 3600 seconds within 3600-86400 second policy bounds.",
            time_to_end_bucket: "lt_6h",
            activity_signal: "high",
            ambiguity_score: 0
          },
          voteStatus: "not_started",
          queueStates: ["needs_scan", "near_expiry"]
        }
      ]
    });

    const scanAllResponse = await fetch(`${baseUrl}/api/reviewer/scan-all`, {
      method: "POST",
      headers: createReviewerHeaders()
    });

    assert.equal(scanAllResponse.status, 202);
    const scanAllPayload = await scanAllResponse.json();
    assert.equal(scanAllPayload.ok, true);
    assert.equal(scanAllPayload.jobs.length, 2);
    assert.equal(scanAllPayload.jobs[0].target.eventId, "gm_btc_above_100k");
    assert.equal(scanAllPayload.jobs[1].target.eventId, "gm_eth_above_5000");

    await waitFor(async () => {
      const storedScans = await reviewerScanRepository.list();
      assert.equal(storedScans.length, 3);
    });

    const storedScans = await reviewerScanRepository.list();
    assert.equal(storedScans.length, 3);
    assert.deepEqual(
      storedScans.map((scan) => ({
        eventId: scan.eventId,
        jobId: scan.jobId,
        recommendation: scan.recommendation,
        hasSuggestedNote: typeof scan.suggested_note === "string",
        hasReviewWindow: typeof (scan.review_window as Record<string, unknown> | undefined)?.review_window_secs === "number"
      })),
      [
        {
          eventId: "gm_btc_above_100k",
          jobId: "job_scan_001",
          recommendation: "review",
          hasSuggestedNote: true,
          hasReviewWindow: true
        },
        {
          eventId: "gm_btc_above_100k",
          jobId: "job_scan_002",
          recommendation: "review",
          hasSuggestedNote: true,
          hasReviewWindow: true
        },
        {
          eventId: "gm_eth_above_5000",
          jobId: "job_scan_003",
          recommendation: "review",
          hasSuggestedNote: true,
          hasReviewWindow: true
        }
      ]
    );
  } finally {
    await stopTestServer(server);
  }
});

test("GET /api/reviewer/scans lists historical reviewer scan records and rejects unauthorized access", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-scan-history-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const backgroundJobRepository = await createBackgroundJobRepository(tempDir);
  const reviewerScanRepository = await createReviewerScanRepository(tempDir);
  const marketCacheRepository = await createMarketCacheRepository(tempDir, [
    VALID_MARKET,
    {
      marketId: "gm_eth_above_5000",
      title: "Will ETH trade above $5,000 before year end?",
      resolution:
        "Resolves YES if Gemini ETH/USD prints above $5,000 before December 31 2026 23:59 UTC.",
      closesAt: "2026-03-21T23:00:00.000Z",
      slug: "eth-above-5000-2026",
      url: "https://example.com/markets/eth-above-5000-2026",
      lastSyncedAt: "2026-03-21T18:59:00.000Z",
      activitySignal: "high"
    }
  ]);
  let nowCallCount = 0;
  const timeline = [
    "2026-03-21T20:00:00.000Z",
    "2026-03-21T20:05:00.000Z",
    "2026-03-21T20:10:00.000Z"
  ];
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    backgroundJobRepository,
    reviewerScanRepository,
    marketCacheRepository,
    now: () => new Date(timeline[Math.min(nowCallCount++, timeline.length - 1)]),
    reviewerAuthToken: "reviewer-secret",
    createBackgroundJobId: (() => {
      let nextJob = 1;
      return () => `job_scan_history_${String(nextJob++).padStart(3, "0")}`;
    })()
  });

  try {
    const unauthorizedResponse = await fetch(`${baseUrl}/api/reviewer/scans`);

    assert.equal(unauthorizedResponse.status, 401);
    assert.deepEqual(await unauthorizedResponse.json(), {
      ok: false,
      error: {
        code: "REVIEWER_AUTH_REQUIRED",
        message: "Reviewer authentication is required for this route."
      }
    });

    await fetch(`${baseUrl}/api/reviewer/scan/gm_btc_above_100k`, {
      method: "POST",
      headers: createReviewerHeaders()
    });
    await fetch(`${baseUrl}/api/reviewer/scan/gm_btc_above_100k`, {
      method: "POST",
      headers: createReviewerHeaders()
    });
    await fetch(`${baseUrl}/api/reviewer/scan/gm_eth_above_5000`, {
      method: "POST",
      headers: createReviewerHeaders()
    });

    await waitFor(async () => {
      const scans = await reviewerScanRepository.list();
      assert.equal(scans.length, 3);
    });

    const response = await fetch(`${baseUrl}/api/reviewer/scans`, {
      headers: createReviewerHeaders()
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.scans.length, 3);
    assert.deepEqual(
      payload.scans.map((scan: { eventId: string }) => scan.eventId).sort(),
      ["gm_btc_above_100k", "gm_btc_above_100k", "gm_eth_above_5000"]
    );
    assert.ok(
      payload.scans.every(
        (scan: Record<string, unknown>) =>
          typeof scan.scanId === "string" &&
          typeof scan.createdAt === "string" &&
          scan.ambiguityScore === 0.72 &&
          scan.recommendation === "review" &&
          typeof (scan.reviewWindow as Record<string, unknown> | undefined)?.review_window_secs === "number"
      )
    );
    assert.ok(
      payload.scans.some(
        (scan: Record<string, unknown>) =>
          scan.eventId === "gm_eth_above_5000" &&
          (scan.reviewWindow as Record<string, unknown>)?.time_to_end_bucket === "lt_6h"
      )
    );
    assert.equal(
      payload.scans.filter((scan: Record<string, unknown>) => scan.eventId === "gm_btc_above_100k").length,
      2
    );
  } finally {
    await stopTestServer(server);
  }
});

test("POST /api/reviewer/jobs/:jobId/retry reruns failed scan jobs without duplicating scan side effects", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-scan-retry-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const backgroundJobRepository = await createBackgroundJobRepository(tempDir);
  const reviewerScanRepository = await createReviewerScanRepository(tempDir);
  const marketCacheRepository = await createMarketCacheRepository(tempDir);
  let shouldFail = true;
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    backgroundJobRepository,
    reviewerScanRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T20:20:00.000Z"),
    reviewerAuthToken: "reviewer-secret",
    createBackgroundJobId: () => "job_scan_retry_001",
    runReviewerMarketScan: async (...args: unknown[]) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("scan worker timeout");
      }

      const { createReviewerMarketScan } = await import("../src/reviewer-scan-service.js");
      return createReviewerMarketScan(args[0] as Parameters<typeof createReviewerMarketScan>[0]);
    }
  });

  try {
    const firstResponse = await fetch(`${baseUrl}/api/reviewer/scan/gm_btc_above_100k`, {
      method: "POST",
      headers: createReviewerHeaders()
    });

    assert.equal(firstResponse.status, 202);

    await waitFor(async () => {
      const job = await backgroundJobRepository.findByJobId("job_scan_retry_001");
      assert.ok(job);
      assert.equal(job.status, "failed");
    });

    assert.deepEqual(await reviewerScanRepository.list(), []);

    const retryResponse = await fetch(
      `${baseUrl}/api/reviewer/jobs/job_scan_retry_001/retry`,
      {
        method: "POST",
        headers: createReviewerHeaders()
      }
    );

    assert.equal(retryResponse.status, 202);

    await waitFor(async () => {
      const scans = await reviewerScanRepository.list();
      assert.equal(scans.length, 1);
    });

    const scans = await reviewerScanRepository.list();
    assert.equal(scans[0].jobId, "job_scan_retry_001");

    const job = await backgroundJobRepository.findByJobId("job_scan_retry_001");
    assert.deepEqual(job, {
      jobId: "job_scan_retry_001",
      kind: "reviewer_scan",
      status: "completed",
      createdAt: "2026-03-21T20:20:00.000Z",
      updatedAt: "2026-03-21T20:20:00.000Z",
      attempts: 2,
      retryable: false,
      target: {
        eventId: "gm_btc_above_100k"
      },
      errorMessage: null,
      result: {
        scanId: "scan_gm_btc_above_100k_2026-03-21T20:20:00.000Z"
      }
    });
  } finally {
    await stopTestServer(server);
  }
});

test("GET /api/reviewer/queue supports persisted queue filters and segment metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-queue-filters-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const reviewerScanRepository = await createReviewerScanRepository(tempDir);
  const marketCacheRepository = await createMarketCacheRepository(tempDir, [
    VALID_MARKET,
    {
      marketId: "gm_eth_above_5000",
      title: "Will ETH trade above $5,000 before year end?",
      resolution:
        "Resolves YES if Gemini ETH/USD prints above $5,000 before December 31 2026 23:59 UTC.",
      closesAt: "2026-03-21T23:00:00.000Z",
      slug: "eth-above-5000-2026",
      url: "https://example.com/markets/eth-above-5000-2026",
      lastSyncedAt: "2026-03-21T18:59:00.000Z",
      activitySignal: "high"
    },
    {
      marketId: "gm_sol_above_300",
      title: "Will SOL trade above $300 before year end?",
      resolution:
        "Resolves YES if Gemini SOL/USD prints above $300 before December 31 2026 23:59 UTC.",
      closesAt: "2026-05-01T12:00:00.000Z",
      slug: "sol-above-300-2026",
      url: "https://example.com/markets/sol-above-300-2026",
      lastSyncedAt: "2026-03-21T18:59:00.000Z",
      activitySignal: "normal"
    }
  ]);

  await clarificationRequestRepository.create({
    clarificationId: "clar_funded_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    reviewerWorkflowStatus: "awaiting_panel_vote",
    eventId: "gm_btc_above_100k",
    question: "Should auction prints count?",
    requesterId: "wallet_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_funded_001",
    paymentProof: "pay_proof_funded_001",
    paymentVerifiedAt: "2026-03-21T20:00:00.000Z",
    createdAt: "2026-03-21T20:00:00.000Z",
    updatedAt: "2026-03-21T20:15:00.000Z"
  });
  await clarificationRequestRepository.create({
    clarificationId: "clar_finalized_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    reviewerWorkflowStatus: "finalized",
    eventId: "gm_sol_above_300",
    question: "Which SOL/USD feed resolves this?",
    requesterId: "wallet_002",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_finalized_001",
    paymentProof: "pay_proof_finalized_001",
    paymentVerifiedAt: "2026-03-21T20:05:00.000Z",
    createdAt: "2026-03-21T20:05:00.000Z",
    updatedAt: "2026-03-21T20:20:00.000Z"
  });

  await reviewerScanRepository.create({
    scanId: "scan_gm_btc_above_100k_2026-03-21T20:10:00.000Z",
    eventId: "gm_btc_above_100k",
    createdAt: "2026-03-21T20:10:00.000Z",
    ambiguity_score: 0.85,
    recommendation: "review",
    flagged_clauses: [VALID_MARKET.resolution],
    suggested_market_text: "Clarified BTC text",
    suggested_note: "Clarified BTC note",
    review_window: {
      review_window_secs: 86400,
      review_window_reason: "Test review window.",
      time_to_end_bucket: "gt_72h",
      activity_signal: "normal",
      ambiguity_score: 0.85
    }
  });
  await reviewerScanRepository.create({
    scanId: "scan_gm_sol_above_300_2026-03-21T20:11:00.000Z",
    eventId: "gm_sol_above_300",
    createdAt: "2026-03-21T20:11:00.000Z",
    ambiguity_score: 0.41,
    recommendation: "monitor",
    flagged_clauses: ["Solana clause"],
    suggested_market_text: "Clarified SOL text",
    suggested_note: "Clarified SOL note",
    review_window: {
      review_window_secs: 21600,
      review_window_reason: "Test review window.",
      time_to_end_bucket: "lt_24h",
      activity_signal: "normal",
      ambiguity_score: 0.41
    }
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    reviewerScanRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T20:30:00.000Z"),
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const allResponse = await fetch(`${baseUrl}/api/reviewer/queue`, {
      headers: createReviewerHeaders()
    });

    assert.equal(allResponse.status, 200);
    assert.deepEqual(await allResponse.json(), {
      ok: true,
      availableCategories: [],
      filters: [
        {
          key: "needs_scan",
          label: "Needs Scan",
          count: 1
        },
        {
          key: "high_ambiguity",
          label: "High Ambiguity",
          count: 1
        },
        {
          key: "funded",
          label: "Funded",
          count: 2
        },
        {
          key: "near_expiry",
          label: "Near Expiry",
          count: 2
        },
        {
          key: "awaiting_panel_vote",
          label: "Awaiting Panel Vote",
          count: 1
        },
        {
          key: "finalized",
          label: "Finalized",
          count: 1
        }
      ],
      queue: [
        {
          eventId: "gm_btc_above_100k",
          latestClarificationId: "clar_funded_001",
          marketTitle: VALID_MARKET.title,
          endTime: VALID_MARKET.closesAt,
          ambiguityScore: 0.85,
          fundingProgress: {
            raisedAmount: "1.00",
            targetAmount: "1.00",
            contributorCount: 1,
            fundingState: "funded"
          },
          reviewWindow: {
            review_window_secs: 86400,
            review_window_reason: "Test review window.",
            time_to_end_bucket: "gt_72h",
            activity_signal: "normal",
            ambiguity_score: 0.85
          },
          voteStatus: "awaiting_panel_vote",
          queueStates: ["high_ambiguity", "funded", "awaiting_panel_vote"]
        },
        {
          eventId: "gm_eth_above_5000",
          latestClarificationId: null,
          marketTitle: "Will ETH trade above $5,000 before year end?",
          endTime: "2026-03-21T23:00:00.000Z",
          ambiguityScore: null,
          fundingProgress: {
            raisedAmount: "0.00",
            targetAmount: "1.00",
            contributorCount: 0,
            fundingState: "unfunded"
          },
          reviewWindow: {
            review_window_secs: 3600,
            review_window_reason:
              "Base window set from lt_6h time-to-end bucket. High activity reduced the review window by one policy step. Final window 3600 seconds within 3600-86400 second policy bounds.",
            time_to_end_bucket: "lt_6h",
            activity_signal: "high",
            ambiguity_score: 0
          },
          voteStatus: "not_started",
          queueStates: ["needs_scan", "near_expiry"]
        },
        {
          eventId: "gm_sol_above_300",
          latestClarificationId: "clar_finalized_001",
          marketTitle: "Will SOL trade above $300 before year end?",
          endTime: "2026-05-01T12:00:00.000Z",
          ambiguityScore: 0.41,
          fundingProgress: {
            raisedAmount: "1.00",
            targetAmount: "1.00",
            contributorCount: 1,
            fundingState: "funded"
          },
          reviewWindow: {
            review_window_secs: 21600,
            review_window_reason: "Test review window.",
            time_to_end_bucket: "lt_24h",
            activity_signal: "normal",
            ambiguity_score: 0.41
          },
          voteStatus: "finalized",
          queueStates: ["funded", "near_expiry", "finalized"]
        }
      ]
    });

    const filteredResponse = await fetch(
      `${baseUrl}/api/reviewer/queue?filter=needs_scan`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(filteredResponse.status, 200);
    assert.deepEqual(await filteredResponse.json(), {
      ok: true,
      activeFilter: "needs_scan",
      availableCategories: [],
      filters: [
        {
          key: "needs_scan",
          label: "Needs Scan",
          count: 1
        },
        {
          key: "high_ambiguity",
          label: "High Ambiguity",
          count: 1
        },
        {
          key: "funded",
          label: "Funded",
          count: 2
        },
        {
          key: "near_expiry",
          label: "Near Expiry",
          count: 2
        },
        {
          key: "awaiting_panel_vote",
          label: "Awaiting Panel Vote",
          count: 1
        },
        {
          key: "finalized",
          label: "Finalized",
          count: 1
        }
      ],
      queue: [
        {
          eventId: "gm_eth_above_5000",
          latestClarificationId: null,
          marketTitle: "Will ETH trade above $5,000 before year end?",
          endTime: "2026-03-21T23:00:00.000Z",
          ambiguityScore: null,
          fundingProgress: {
            raisedAmount: "0.00",
            targetAmount: "1.00",
            contributorCount: 0,
            fundingState: "unfunded"
          },
          reviewWindow: {
            review_window_secs: 3600,
            review_window_reason:
              "Base window set from lt_6h time-to-end bucket. High activity reduced the review window by one policy step. Final window 3600 seconds within 3600-86400 second policy bounds.",
            time_to_end_bucket: "lt_6h",
            activity_signal: "high",
            ambiguity_score: 0
          },
          voteStatus: "not_started",
          queueStates: ["needs_scan", "near_expiry"]
        }
      ]
    });
  } finally {
    await stopTestServer(server);
  }
});

test("GET /api/reviewer/clarifications/:clarificationId/audit reconstructs lifecycle state from persisted records", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-audit-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const artifactRepository = new FileArtifactRepository(path.join(tempDir, "artifacts.json"));
  const marketCacheRepository = await createMarketCacheRepository(tempDir);

  const artifact = await artifactRepository.createArtifact({
    clarificationId: "clar_audit_001",
    eventId: "gm_btc_above_100k",
    marketText: VALID_MARKET.resolution,
    suggestedEditedMarketText:
      "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
    clarificationNote:
      "Resolve only from Gemini's primary BTC/USD spot feed and exclude auction prints.",
    generatedAtUtc: "2026-03-21T22:00:03.000Z"
  });

  await clarificationRequestRepository.create({
    clarificationId: "clar_audit_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should Gemini auction prints count toward resolution?",
    normalizedInput: {
      eventId: "gm_btc_above_100k",
      question: "Should Gemini auction prints count toward resolution?"
    },
    requesterId: "wallet_audit_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_audit_001",
    paymentProof: "pay_proof_audit_001",
    paymentVerifiedAt: "2026-03-21T22:00:00.000Z",
    llmOutput: {
      verdict: "needs_clarification",
      llm_status: "completed",
      reasoning: "The market text does not specify whether Gemini auction prints qualify.",
      cited_clause: VALID_MARKET.resolution,
      ambiguity_score: 0.81,
      ambiguity_summary: "Gemini price source handling is ambiguous.",
      suggested_market_text:
        "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC?",
      suggested_note:
        "Use Gemini's primary BTC/USD spot exchange feed and exclude auction-only prints."
    },
    llmTrace: {
      promptTemplateVersion: "prompt-v1",
      modelId: "gemini-reviewer-001",
      requestedAt: "2026-03-21T22:00:02.000Z",
      processingVersion: "offchain-pipeline-2026-03-21"
    },
    artifactCid: artifact.cid,
    artifactUrl: artifact.url,
    reviewerWorkflowStatus: "finalized",
    finalEditedText:
      "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
    finalNote:
      "Resolve only from Gemini's primary BTC/USD spot feed and exclude auction prints.",
    finalizedAt: "2026-03-21T22:05:00.000Z",
    finalizedBy: "reviewer.alex",
    funding: {
      targetAmount: "1.00",
      raisedAmount: "1.00",
      contributorCount: 1,
      fundingState: "funded",
      history: [
        {
          contributor: "wallet_audit_001",
          amount: "1.00",
          timestamp: "2026-03-21T22:04:00.000Z",
          reference: "fund_ref_audit_001"
        }
      ]
    },
    reviewerActions: [
      {
        type: "marked_awaiting_panel_vote",
        actor: "reviewer.casey",
        timestamp: "2026-03-21T22:03:00.000Z",
        previousReviewerWorkflowStatus: "not_started"
      },
      {
        type: "finalized",
        actor: "reviewer.alex",
        timestamp: "2026-03-21T22:05:00.000Z",
        previousReviewerWorkflowStatus: "awaiting_panel_vote",
        finalEditedText:
          "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
        finalNote:
          "Resolve only from Gemini's primary BTC/USD spot feed and exclude auction prints."
      }
    ],
    statusHistory: [
      {
        status: "queued",
        timestamp: "2026-03-21T22:00:00.000Z"
      },
      {
        status: "processing",
        timestamp: "2026-03-21T22:00:01.000Z"
      },
      {
        status: "completed",
        timestamp: "2026-03-21T22:00:03.000Z"
      }
    ],
    createdAt: "2026-03-21T22:00:00.000Z",
    updatedAt: "2026-03-21T22:05:00.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    artifactRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T22:06:00.000Z"),
    reviewerAuthToken: "reviewer-secret"
  });

  try {
    const unauthorizedResponse = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_audit_001/audit`
    );
    assert.equal(unauthorizedResponse.status, 401);

    const response = await fetch(
      `${baseUrl}/api/reviewer/clarifications/clar_audit_001/audit`,
      {
        headers: createReviewerHeaders()
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      audit: {
        clarificationId: "clar_audit_001",
        eventId: "gm_btc_above_100k",
        request: {
          requestId: null,
          source: "paid_api",
          requesterId: "wallet_audit_001",
          question: "Should Gemini auction prints count toward resolution?",
          normalizedInput: {
            eventId: "gm_btc_above_100k",
            question: "Should Gemini auction prints count toward resolution?"
          },
          createdAt: "2026-03-21T22:00:00.000Z"
        },
        payment: {
          amount: "1.00",
          asset: "USDC",
          reference: "x402_ref_audit_001",
          proof: "pay_proof_audit_001",
          verifiedAt: "2026-03-21T22:00:00.000Z"
        },
        statusHistory: [
          {
            status: "queued",
            timestamp: "2026-03-21T22:00:00.000Z"
          },
          {
            status: "processing",
            timestamp: "2026-03-21T22:00:01.000Z"
          },
          {
            status: "completed",
            timestamp: "2026-03-21T22:00:03.000Z"
          }
        ],
        llm: {
          output: {
            verdict: "needs_clarification",
            llm_status: "completed",
            reasoning:
              "The market text does not specify whether Gemini auction prints qualify.",
            cited_clause: VALID_MARKET.resolution,
            ambiguity_score: 0.81,
            ambiguity_summary: "Gemini price source handling is ambiguous.",
            suggested_market_text:
              "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC?",
            suggested_note:
              "Use Gemini's primary BTC/USD spot exchange feed and exclude auction-only prints."
          },
          trace: {
            promptTemplateVersion: "prompt-v1",
            modelId: "gemini-reviewer-001",
            requestedAt: "2026-03-21T22:00:02.000Z",
            processingVersion: "offchain-pipeline-2026-03-21"
          }
        },
        artifact: {
          cid: artifact.cid,
          url: artifact.url,
          generatedAtUtc: "2026-03-21T22:00:03.000Z"
        },
        funding: {
          targetAmount: "1.00",
          raisedAmount: "1.00",
          contributorCount: 1,
          fundingState: "funded",
          history: [
            {
              contributor: "wallet_audit_001",
              amount: "1.00",
              timestamp: "2026-03-21T22:04:00.000Z",
              reference: "fund_ref_audit_001"
            }
          ]
        },
        reviewerActions: [
          {
            type: "marked_awaiting_panel_vote",
            actor: "reviewer.casey",
            timestamp: "2026-03-21T22:03:00.000Z",
            previousReviewerWorkflowStatus: "not_started"
          },
          {
            type: "finalized",
            actor: "reviewer.alex",
            timestamp: "2026-03-21T22:05:00.000Z",
            previousReviewerWorkflowStatus: "awaiting_panel_vote",
            finalEditedText:
              "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
            finalNote:
              "Resolve only from Gemini's primary BTC/USD spot feed and exclude auction prints."
          }
        ],
        finalization: {
          reviewerWorkflowStatus: "finalized",
          finalEditedText:
            "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
          finalNote:
            "Resolve only from Gemini's primary BTC/USD spot feed and exclude auction prints.",
          finalizedAt: "2026-03-21T22:05:00.000Z",
          finalizedBy: "reviewer.alex"
        },
        timeline: [
          {
            type: "status_changed",
            timestamp: "2026-03-21T22:00:00.000Z",
            status: "queued"
          },
          {
            type: "status_changed",
            timestamp: "2026-03-21T22:00:01.000Z",
            status: "processing"
          },
          {
            type: "llm_requested",
            timestamp: "2026-03-21T22:00:02.000Z",
            promptTemplateVersion: "prompt-v1",
            modelId: "gemini-reviewer-001",
            processingVersion: "offchain-pipeline-2026-03-21"
          },
          {
            type: "status_changed",
            timestamp: "2026-03-21T22:00:03.000Z",
            status: "completed"
          },
          {
            type: "artifact_published",
            timestamp: "2026-03-21T22:00:03.000Z",
            cid: artifact.cid,
            url: artifact.url
          },
          {
            type: "reviewer_action",
            timestamp: "2026-03-21T22:03:00.000Z",
            action: "marked_awaiting_panel_vote",
            actor: "reviewer.casey",
            details: {
              previousReviewerWorkflowStatus: "not_started"
            }
          },
          {
            type: "funding_contribution_recorded",
            timestamp: "2026-03-21T22:04:00.000Z",
            contributor: "wallet_audit_001",
            amount: "1.00",
            reference: "fund_ref_audit_001"
          },
          {
            type: "reviewer_action",
            timestamp: "2026-03-21T22:05:00.000Z",
            action: "finalized",
            actor: "reviewer.alex",
            details: {
              previousReviewerWorkflowStatus: "awaiting_panel_vote",
              finalEditedText:
                "Will Gemini BTC/USD spot trade above $100,000 on the primary exchange feed before December 31 2026 23:59 UTC, excluding auction prints?",
              finalNote:
                "Resolve only from Gemini's primary BTC/USD spot feed and exclude auction prints."
            }
          }
        ]
      }
    });
  } finally {
    await stopTestServer(server);
  }
});
