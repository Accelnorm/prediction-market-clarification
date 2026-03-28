import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import { createServer } from "../src/server.js";
import { FileMarketCacheRepository } from "../src/market-cache-repository.js";
import { FileReviewerScanRepository } from "../src/reviewer-scan-repository.js";

const UPCOMING_MARKET = {
  marketId: "9058",
  ticker: "BRENT2603222100",
  title: "Oil (Brent) price tomorrow?",
  description: "Interval Brent price prediction event expiring on March 22, 2026 @ 5pm EDT",
  resolution: "Interval Brent price prediction event expiring on March 22, 2026 @ 5pm EDT",
  resolutionText: "Interval Brent price prediction event expiring on March 22, 2026 @ 5pm EDT",
  closesAt: "2026-03-22T21:00:00.000Z",
  endTime: "2026-03-22T21:00:00.000Z",
  slug: "oil-brent-price-tomorrow",
  url: "https://www.gemini.com/prediction-markets/oil-brent-price-tomorrow",
  category: "Commodities",
  subcategory: {
    id: "122",
    slug: "commodities_oil-(brent)",
    name: "Oil (Brent)",
    path: ["Commodities", "Oil (Brent)"]
  },
  tags: ["Oil (Brent)"],
  status: "approved",
  effectiveDate: "2026-03-21T19:56:51.528Z",
  expiryDate: "2026-03-22T21:00:00.000Z",
  resolvedAt: null,
  termsLink: "https://example.com/terms/brent",
  contracts: [
    {
      id: "9058-77358",
      label: "$106 or above",
      abbreviatedName: ">$106",
      description: "If the price is greater than $106, the market resolves to Yes.",
      status: "active",
      ticker: "HI106",
      instrumentSymbol: "GEMI-BRENT2603222100-HI106",
      marketState: "open",
      effectiveDate: "2026-03-21T21:00:00.000Z",
      expiryDate: "2026-03-22T21:00:00.000Z",
      termsAndConditionsUrl: "https://example.com/terms/brent-hi106",
      prices: {
        buy: { yes: "0.91", no: "0.10" }
      },
      sortOrder: 8
    }
  ],
  lastSyncedAt: "2026-03-21T20:00:00.000Z"
};

function buildUpcomingMarket(overrides: Record<string, unknown> = {}) {
  return {
    ...UPCOMING_MARKET,
    ...overrides,
    contracts: (overrides.contracts as unknown[] | undefined) ?? UPCOMING_MARKET.contracts
  };
}

type TestServerOptions = Partial<Parameters<typeof createServer>[0]> & { now: () => Date };

async function startTestServer(options: TestServerOptions) {
  const server = createServer(options as Parameters<typeof createServer>[0]);

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

async function createUpcomingMarketCacheRepository(tempDir: string, markets: unknown[] = [UPCOMING_MARKET]) {
  const repository = new FileMarketCacheRepository(path.join(tempDir, "upcoming-market-cache.json"));
  await repository.save(markets as Parameters<typeof repository.save>[0]);
  return repository;
}

async function createUpcomingReviewerScanRepository(tempDir: string) {
  const repository = new FileReviewerScanRepository(path.join(tempDir, "upcoming-reviewer-scans.json"));
  await repository.save([]);
  return repository;
}

test("reviewer prelaunch queue and scan endpoints operate on upcoming Gemini markets only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prelaunch-reviewer-"));
  const upcomingMarketCacheRepository = await createUpcomingMarketCacheRepository(tempDir);
  const upcomingReviewerScanRepository = await createUpcomingReviewerScanRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    reviewerAuthToken: "reviewer-secret",
    now: () => new Date("2026-03-21T21:00:00.000Z"),
    upcomingMarketCacheRepository,
    upcomingReviewerScanRepository
  });

  try {
    const initialQueueResponse = await fetch(`${baseUrl}/api/reviewer/prelaunch/queue`, {
      headers: createReviewerHeaders()
    });

    assert.equal(initialQueueResponse.status, 200);
    const initialQueuePayload = await initialQueueResponse.json();
    assert.equal(initialQueuePayload.queue.length, 1);
    assert.equal(initialQueuePayload.queue[0].eventId, "9058");
    assert.equal(initialQueuePayload.queue[0].needsScan, true);

    const scanResponse = await fetch(`${baseUrl}/api/reviewer/prelaunch/scan/9058`, {
      method: "POST",
      headers: createReviewerHeaders()
    });

    assert.equal(scanResponse.status, 202);
    const scanPayload = await scanResponse.json();
    assert.equal(scanPayload.scan.eventId, "9058");

    const detailResponse = await fetch(`${baseUrl}/api/reviewer/prelaunch/markets/9058`, {
      headers: createReviewerHeaders()
    });

    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.market.marketId, "9058");
    assert.equal(detailPayload.market.ticker, "BRENT2603222100");
    assert.equal(detailPayload.market.contracts.length, 1);
    assert.equal(detailPayload.latestScan.eventId, "9058");

    const queueAfterScanResponse = await fetch(`${baseUrl}/api/reviewer/prelaunch/queue`, {
      headers: createReviewerHeaders()
    });

    assert.equal(queueAfterScanResponse.status, 200);
    const queueAfterScanPayload = await queueAfterScanResponse.json();
    assert.equal(queueAfterScanPayload.queue[0].needsScan, false);
    assert.equal(queueAfterScanPayload.queue[0].latestScanId, scanPayload.scan.scanId);
  } finally {
    await stopTestServer(server);
  }
});

test("prelaunch queue marks repeated template markets as covered instead of separate needs-scan work", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prelaunch-reviewer-"));
  const upcomingMarkets = [
    buildUpcomingMarket({
      marketId: "9058",
      ticker: "BTC2603220200",
      title: "BTC price today at 2am EDT",
      slug: "btc-price-today-at-2am-edt",
      description: "Interval BTC price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolution: "Interval BTC price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolutionText: "Interval BTC price prediction event expiring on March 22, 2026 @ 2am EDT",
      termsLink: null
    }),
    buildUpcomingMarket({
      marketId: "9059",
      ticker: "ETH2603220200",
      title: "ETH price today at 2am EDT",
      slug: "eth-price-today-at-2am-edt",
      description: "Interval ETH price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolution: "Interval ETH price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolutionText: "Interval ETH price prediction event expiring on March 22, 2026 @ 2am EDT",
      termsLink: null
    })
  ];
  const upcomingMarketCacheRepository = await createUpcomingMarketCacheRepository(tempDir, upcomingMarkets);
  const upcomingReviewerScanRepository = await createUpcomingReviewerScanRepository(tempDir);
  const { server, baseUrl } = await startTestServer({
    reviewerAuthToken: "reviewer-secret",
    now: () => new Date("2026-03-21T21:00:00.000Z"),
    upcomingMarketCacheRepository,
    upcomingReviewerScanRepository
  });

  try {
    const queueResponse = await fetch(`${baseUrl}/api/reviewer/prelaunch/queue`, {
      headers: createReviewerHeaders()
    });

    assert.equal(queueResponse.status, 200);
    const queuePayload = await queueResponse.json();
    assert.equal(queuePayload.queue.length, 2);
    assert.equal(queuePayload.queue[0].eventId, "9058");
    assert.equal(queuePayload.queue[0].needsScan, true);
    assert.equal(queuePayload.queue[1].eventId, "9059");
    assert.equal(queuePayload.queue[1].needsScan, false);
  } finally {
    await stopTestServer(server);
  }
});

test("prelaunch scan-all only analyzes future upcoming markets and reuses shared template scans", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prelaunch-reviewer-"));
  const upcomingMarkets = [
    buildUpcomingMarket({
      marketId: "9058",
      ticker: "BTC2603220200",
      title: "BTC price today at 2am EDT",
      slug: "btc-price-today-at-2am-edt",
      description: "Interval BTC price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolution: "Interval BTC price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolutionText: "Interval BTC price prediction event expiring on March 22, 2026 @ 2am EDT",
      termsLink: null
    }),
    buildUpcomingMarket({
      marketId: "9059",
      ticker: "ETH2603220200",
      title: "ETH price today at 2am EDT",
      slug: "eth-price-today-at-2am-edt",
      description: "Interval ETH price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolution: "Interval ETH price prediction event expiring on March 22, 2026 @ 2am EDT",
      resolutionText: "Interval ETH price prediction event expiring on March 22, 2026 @ 2am EDT",
      termsLink: null
    }),
    buildUpcomingMarket({
      marketId: "9060",
      ticker: "BRENT2603202100",
      title: "Expired market should not scan",
      slug: "expired-market-should-not-scan",
      closesAt: "2026-03-20T21:00:00.000Z",
      endTime: "2026-03-20T21:00:00.000Z",
      expiryDate: "2026-03-20T21:00:00.000Z",
      resolution: "Resolves YES if Brent settles above $106 on March 20 2026.",
      resolutionText: "Resolves YES if Brent settles above $106 on March 20 2026."
    })
  ];
  const upcomingMarketCacheRepository = await createUpcomingMarketCacheRepository(
    tempDir,
    upcomingMarkets
  );
  const upcomingReviewerScanRepository = await createUpcomingReviewerScanRepository(tempDir);
  const originalFetch = globalThis.fetch;
  const llmRequests: Array<{ url: unknown; options: unknown }> = [];

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
                    reasoning: "The resolution text does not specify whether auction prints count.",
                    cited_clause:
                      "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
                    ambiguity_score: 0.81,
                    ambiguity_summary: "The qualifying Gemini trade source is underspecified.",
                    suggested_market_text:
                      "Will Gemini BTC/USD spot trade above $100,000 on the primary continuous order book before December 31 2026 23:59 UTC?",
                    suggested_note:
                      "Exclude auctions and use the first qualifying continuous-order-book trade."
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
    reviewerAuthToken: "reviewer-secret",
    now: () => new Date("2026-03-21T21:00:00.000Z"),
    llmRuntime: {
      provider: "openrouter",
      apiKey: "openrouter-key",
      model: "openrouter/auto",
      baseUrl: "https://openrouter.test/api/v1"
    },
    upcomingMarketCacheRepository,
    upcomingReviewerScanRepository
  });

  try {
    const scanAllResponse = await fetch(`${baseUrl}/api/reviewer/prelaunch/scan-all`, {
      method: "POST",
      headers: createReviewerHeaders()
    });

    assert.equal(scanAllResponse.status, 202);
    const scanAllPayload = await scanAllResponse.json();
    assert.equal(scanAllPayload.ok, true);
    assert.equal(scanAllPayload.scans.length, 2);
    assert.equal(llmRequests.length, 1);
    const llmRequestBody = JSON.parse((llmRequests[0] as { options: { body: string } }).options.body);
    assert.match(llmRequestBody.messages[0].content, /# Review Upcoming Market/);
    assert.match(
      llmRequestBody.messages[0].content,
      /Return output that fits the repo's reviewer scan shape/
    );

    const storedScans = await upcomingReviewerScanRepository.list();
    assert.equal(storedScans.length, 2);
    assert.deepEqual(
      storedScans.map((scan) => scan.eventId).sort(),
      ["9058", "9059"]
    );
    assert.equal(
      storedScans.filter((scan) => scan.eventId === "9060").length,
      0
    );

    const primaryScan = storedScans.find((scan) => scan.eventId === "9058");
    const reusedScan = storedScans.find((scan) => scan.eventId === "9059");

    assert.ok(primaryScan);
    assert.ok(reusedScan);
    assert.equal(primaryScan.ambiguity_score, 0.81);
    assert.equal(reusedScan.ambiguity_score, 0.81);
    assert.equal(reusedScan.reusedFromEventId, "9058");
    assert.equal(reusedScan.marketTextKey, primaryScan.marketTextKey);
  } finally {
    globalThis.fetch = originalFetch;
    await stopTestServer(server);
  }
});
