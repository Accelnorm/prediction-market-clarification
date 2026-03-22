import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

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

async function createUpcomingMarketCacheRepository(tempDir, markets = [UPCOMING_MARKET]) {
  const repository = new FileMarketCacheRepository(path.join(tempDir, "upcoming-market-cache.json"));
  await repository.save(markets);
  return repository;
}

async function createUpcomingReviewerScanRepository(tempDir) {
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
