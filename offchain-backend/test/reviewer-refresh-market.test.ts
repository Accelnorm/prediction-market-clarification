// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { createServer } from "../src/server.js";
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

async function createMarketCacheRepository(tempDir: any, markets: any = [VALID_MARKET]) {
  const repository = new FileMarketCacheRepository(path.join(tempDir, "market-cache.json"));
  await repository.save(markets);
  return repository;
}

function createReviewerHeaders(token: any = "reviewer-secret") {
  return {
    "x-reviewer-token": token
  };
}

test("POST /api/reviewer/refresh-market/:eventId refreshes cached market data without changing clarification history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reviewer-refresh-market-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = await createMarketCacheRepository(tempDir);

  await clarificationRequestRepository.create({
    clarificationId: "clar_refresh_seed_001",
    requestId: null,
    source: "paid_api",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should auction prints count?",
    requesterId: "wallet_refresh_001",
    paymentAmount: "1.00",
    paymentAsset: "USDC",
    paymentReference: "x402_ref_refresh_001",
    paymentProof: "pay_proof_refresh_001",
    paymentVerifiedAt: "2026-03-21T20:41:00.000Z",
    createdAt: "2026-03-21T20:41:00.000Z",
    updatedAt: "2026-03-21T20:41:00.000Z"
  });

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-21T21:00:00.000Z"),
    reviewerAuthToken: "reviewer-secret",
    fetchReviewerMarketSource: async (eventId: any) => {
      assert.equal(eventId, "gm_btc_above_100k");
      return {
        id: "gm_btc_above_100k",
        title: "Will BTC trade above $105,000 before year end?",
        resolution:
          "Resolves YES if Gemini BTC/USD spot prints above $105,000 before December 31 2026 23:59 UTC.",
        closesAt: "2026-12-30T23:59:00.000Z",
        slug: "btc-above-105k-2026",
        url: "https://example.com/markets/btc-above-105k-2026",
        activitySignal: "high"
      };
    }
  });

  try {
    const response = await fetch(`${baseUrl}/api/reviewer/refresh-market/gm_btc_above_100k`, {
      method: "POST",
      headers: createReviewerHeaders()
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      market: {
        marketId: "gm_btc_above_100k",
        title: "Will BTC trade above $105,000 before year end?",
        resolution:
          "Resolves YES if Gemini BTC/USD spot prints above $105,000 before December 31 2026 23:59 UTC.",
        resolutionText:
          "Resolves YES if Gemini BTC/USD spot prints above $105,000 before December 31 2026 23:59 UTC.",
        closesAt: "2026-12-30T23:59:00.000Z",
        endTime: "2026-12-30T23:59:00.000Z",
        slug: "btc-above-105k-2026",
        url: "https://example.com/markets/btc-above-105k-2026",
        lastSyncedAt: "2026-03-21T18:59:00.000Z",
        lastRefreshedAt: "2026-03-21T21:00:00.000Z",
        ticker: null,
        description: "",
        category: null,
        subcategory: null,
        tags: [],
        status: null,
        createdAt: null,
        effectiveDate: null,
        expiryDate: "2026-12-30T23:59:00.000Z",
        resolvedAt: null,
        termsLink: null,
        contracts: [],
        activitySignal: "high"
      }
    });

    const refreshedMarket = await marketCacheRepository.findByMarketId("gm_btc_above_100k");
    assert.deepEqual(refreshedMarket, {
      marketId: "gm_btc_above_100k",
      title: "Will BTC trade above $105,000 before year end?",
      resolution:
        "Resolves YES if Gemini BTC/USD spot prints above $105,000 before December 31 2026 23:59 UTC.",
      resolutionText:
        "Resolves YES if Gemini BTC/USD spot prints above $105,000 before December 31 2026 23:59 UTC.",
      closesAt: "2026-12-30T23:59:00.000Z",
      endTime: "2026-12-30T23:59:00.000Z",
      slug: "btc-above-105k-2026",
      url: "https://example.com/markets/btc-above-105k-2026",
      lastSyncedAt: "2026-03-21T18:59:00.000Z",
      lastRefreshedAt: "2026-03-21T21:00:00.000Z",
      ticker: null,
      description: "",
      category: null,
      subcategory: null,
      tags: [],
      status: null,
      createdAt: null,
      effectiveDate: null,
      expiryDate: "2026-12-30T23:59:00.000Z",
      resolvedAt: null,
      termsLink: null,
      contracts: [],
      activitySignal: "high"
    });

    const storedClarification =
      await clarificationRequestRepository.findByClarificationId("clar_refresh_seed_001");
    assert.ok(storedClarification);
    assert.equal(storedClarification.updatedAt, "2026-03-21T20:41:00.000Z");
    assert.equal(storedClarification.question, "Should auction prints count?");
    assert.equal(storedClarification.eventId, "gm_btc_above_100k");
  } finally {
    await stopTestServer(server);
  }
});
