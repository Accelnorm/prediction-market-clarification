import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";

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

async function startTestServer(options: Parameters<typeof createServer>[0]) {
  const server = createServer(options);

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

test("phase 2 routes return 404 when disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "phase1-routes-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const marketCacheRepository = new FileMarketCacheRepository(
    path.join(tempDir, "market-cache.json")
  );
  await marketCacheRepository.save([VALID_MARKET]);

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    marketCacheRepository,
    now: () => new Date("2026-03-22T00:00:00.000Z"),
    enablePhase2Routes: false
  });

  try {
    const reviewerResponse = await fetch(`${baseUrl}/api/reviewer/queue`);
    assert.equal(reviewerResponse.status, 404);

    const artifactResponse = await fetch(`${baseUrl}/api/artifacts/test-cid`);
    assert.equal(artifactResponse.status, 404);
  } finally {
    await stopTestServer(server);
  }
});

test("telegram routes return 404 when disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "phase1-telegram-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );

  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    now: () => new Date("2026-03-22T00:00:00.000Z"),
    enableTelegramRoutes: false
  });

  try {
    const telegramResponse = await fetch(`${baseUrl}/api/telegram/requests?chat_id=1`);
    assert.equal(telegramResponse.status, 404);
  } finally {
    await stopTestServer(server);
  }
});

test("health endpoints report liveness and readiness", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "phase1-health-"));
  const clarificationRequestRepository = new FileClarificationRequestRepository(
    path.join(tempDir, "clarification-requests.json")
  );
  const { server, baseUrl } = await startTestServer({
    clarificationRequestRepository,
    readinessCheck: async () => ({
      ok: true,
      checks: {
        database: "ok"
      }
    }),
    now: () => new Date("2026-03-22T00:00:00.000Z")
  });

  try {
    const liveResponse = await fetch(`${baseUrl}/health/live`);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await liveResponse.json(), { ok: true });

    const readyResponse = await fetch(`${baseUrl}/health/ready`);
    assert.equal(readyResponse.status, 200);
    assert.deepEqual(await readyResponse.json(), {
      ok: true,
      checks: {
        database: "ok",
        shuttingDown: "ok"
      }
    });
  } finally {
    await stopTestServer(server);
  }
});
