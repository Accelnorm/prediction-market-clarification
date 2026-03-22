import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";

import { FileMarketCacheRepository } from "../src/market-cache-repository.js";
import { syncMarkets } from "../src/sync-markets.js";

const activeMarket = {
  id: "gm_eth_above_5000",
  title: "Will ETH trade above $5,000 before July 1?",
  resolution: "Resolves YES if ETH/USD on Gemini is above $5,000 at any time before July 1 2026 00:00 UTC.",
  closesAt: "2026-06-30T23:59:00.000Z",
  slug: "eth-above-5000-july-2026",
  url: "https://example.com/markets/eth-above-5000-july-2026",
  status: "active"
};

const inactiveMarket = {
  id: "gm_btc_below_50000",
  title: "Will BTC go below $50,000 this week?",
  resolution: "Resolves YES if BTC/USD on Gemini trades below $50,000 before Friday close.",
  closesAt: "2026-03-28T23:59:00.000Z",
  slug: "btc-below-50000",
  status: "resolved"
};

test("syncMarkets stores normalized active markets in a file-backed cache", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-sync-"));
  const cachePath = path.join(tempDir, "markets.json");
  const repository = new FileMarketCacheRepository(cachePath);
  const lastSyncedAt = "2026-03-21T15:00:00.000Z";

  const result = await syncMarkets({
    repository,
    fetchMarkets: async () => [activeMarket, inactiveMarket],
    now: () => new Date(lastSyncedAt)
  });

  assert.deepEqual(result, {
    inserted: 1,
    updated: 0,
    totalActive: 1
  });

  const stored = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(stored.markets.length, 1);
  assert.deepEqual(stored.markets[0], {
    marketId: activeMarket.id,
    title: activeMarket.title,
    resolutionText: activeMarket.resolution,
    endTime: activeMarket.closesAt,
    slug: activeMarket.slug,
    url: activeMarket.url,
    lastSyncedAt
  });
});

test("syncMarkets is idempotent when the same active markets are fetched twice", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-sync-"));
  const cachePath = path.join(tempDir, "markets.json");
  const repository = new FileMarketCacheRepository(cachePath);

  await syncMarkets({
    repository,
    fetchMarkets: async () => [activeMarket],
    now: () => new Date("2026-03-21T15:00:00.000Z")
  });

  const result = await syncMarkets({
    repository,
    fetchMarkets: async () => [activeMarket],
    now: () => new Date("2026-03-21T16:00:00.000Z")
  });

  assert.deepEqual(result, {
    inserted: 0,
    updated: 1,
    totalActive: 1
  });

  const stored = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(stored.markets.length, 1);
  assert.equal(stored.markets[0].lastSyncedAt, "2026-03-21T16:00:00.000Z");
});

test("syncMarkets updates changed source fields on re-sync", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-sync-"));
  const cachePath = path.join(tempDir, "markets.json");
  const repository = new FileMarketCacheRepository(cachePath);
  const sourcePath = path.join(tempDir, "source.json");

  await writeFile(sourcePath, JSON.stringify({ markets: [activeMarket] }, null, 2));

  const fetchMarkets = async () => {
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    return source.markets;
  };

  await syncMarkets({
    repository,
    fetchMarkets,
    now: () => new Date("2026-03-21T15:00:00.000Z")
  });

  await writeFile(
    sourcePath,
    JSON.stringify(
      {
        markets: [
          {
            ...activeMarket,
            title: "Will ETH trade above $5,200 before July 1?",
            resolution: "Resolves YES if ETH/USD on Gemini is above $5,200 before July 1 2026 00:00 UTC."
          }
        ]
      },
      null,
      2
    )
  );

  const result = await syncMarkets({
    repository,
    fetchMarkets,
    now: () => new Date("2026-03-21T17:30:00.000Z")
  });

  assert.deepEqual(result, {
    inserted: 0,
    updated: 1,
    totalActive: 1
  });

  const stored = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(stored.markets[0].title, "Will ETH trade above $5,200 before July 1?");
  assert.equal(
    stored.markets[0].resolutionText,
    "Resolves YES if ETH/USD on Gemini is above $5,200 before July 1 2026 00:00 UTC."
  );
  assert.equal(stored.markets[0].lastSyncedAt, "2026-03-21T17:30:00.000Z");
});
