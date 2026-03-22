import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";

import { FileMarketCacheRepository } from "../src/market-cache-repository.js";
import { syncMarkets, syncUpcomingMarkets } from "../src/sync-markets.js";

const activeMarket = {
  id: "gm_eth_above_5000",
  ticker: "ETH5K2026",
  title: "Will ETH trade above $5,000 before July 1?",
  description:
    "Resolves YES if ETH/USD on Gemini is above $5,000 at any time before July 1 2026 00:00 UTC.",
  effectiveDate: "2026-03-21T12:00:00.000Z",
  expiryDate: "2026-06-30T23:59:00.000Z",
  slug: "eth-above-5000-july-2026",
  category: "Crypto",
  subcategory: {
    id: 101,
    slug: "crypto_eth",
    name: "Ethereum",
    path: ["Crypto", "Ethereum"]
  },
  tags: ["Ethereum", "Price"],
  termsLink: "https://example.com/terms/eth-5k",
  contracts: [
    {
      id: "gm_eth_above_5000_yes",
      label: "Yes",
      abbreviatedName: "YES",
      description: { content: [{ value: "YES if ETH/USD trades above $5,000." }] },
      status: "active",
      ticker: "ETH5K-YES",
      instrumentSymbol: "GEMI-ETH5K-YES",
      marketState: "open",
      effectiveDate: "2026-03-21T12:00:00.000Z",
      expiryDate: "2026-06-30T23:59:00.000Z",
      termsAndConditionsUrl: "https://example.com/terms/eth-5k-contract",
      prices: {
        buy: { yes: "0.55", no: "0.46" },
        sell: { yes: "0.54", no: "0.45" }
      },
      sortOrder: 1
    }
  ],
  status: "active"
};

const upcomingMarket = {
  id: "gm_sol_above_500",
  ticker: "SOL5002026",
  title: "Will SOL trade above $500 before year end?",
  description:
    "Resolves YES if SOL/USD on Gemini is above $500 before December 31 2026 23:59 UTC.",
  effectiveDate: "2026-04-01T00:00:00.000Z",
  expiryDate: "2026-12-31T23:59:00.000Z",
  slug: "sol-above-500-2026",
  category: "Crypto",
  tags: ["Solana"],
  contracts: [],
  status: "approved"
};

const inactiveMarket = {
  id: "gm_btc_below_50000",
  title: "Will BTC go below $50,000 this week?",
  description: "Resolves YES if BTC/USD on Gemini trades below $50,000 before Friday close.",
  expiryDate: "2026-03-28T23:59:00.000Z",
  slug: "btc-below-50000",
  status: "settled"
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
    ticker: activeMarket.ticker,
    title: activeMarket.title,
    description: activeMarket.description,
    resolution: activeMarket.description,
    resolutionText: activeMarket.description,
    closesAt: activeMarket.expiryDate,
    endTime: activeMarket.expiryDate,
    slug: activeMarket.slug,
    url: "https://www.gemini.com/prediction-markets/eth-above-5000-july-2026",
    category: activeMarket.category,
    subcategory: {
      id: "101",
      slug: "crypto_eth",
      name: "Ethereum",
      path: ["Crypto", "Ethereum"]
    },
    tags: ["Ethereum", "Price"],
    status: "active",
    effectiveDate: activeMarket.effectiveDate,
    expiryDate: activeMarket.expiryDate,
    resolvedAt: null,
    termsLink: activeMarket.termsLink,
    contracts: [
      {
        id: "gm_eth_above_5000_yes",
        label: "Yes",
        abbreviatedName: "YES",
        description: "YES if ETH/USD trades above $5,000.",
        status: "active",
        ticker: "ETH5K-YES",
        instrumentSymbol: "GEMI-ETH5K-YES",
        marketState: "open",
        effectiveDate: "2026-03-21T12:00:00.000Z",
        expiryDate: "2026-06-30T23:59:00.000Z",
        termsAndConditionsUrl: "https://example.com/terms/eth-5k-contract",
        prices: {
          buy: { yes: "0.55", no: "0.46" },
          sell: { yes: "0.54", no: "0.45" }
        },
        sortOrder: 1
      }
    ],
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
            description:
              "Resolves YES if ETH/USD on Gemini is above $5,200 before July 1 2026 00:00 UTC."
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

test("syncUpcomingMarkets stores approved Gemini upcoming markets in a separate cache", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "upcoming-market-sync-"));
  const cachePath = path.join(tempDir, "upcoming-markets.json");
  const repository = new FileMarketCacheRepository(cachePath);
  const lastSyncedAt = "2026-03-21T18:00:00.000Z";

  const result = await syncUpcomingMarkets({
    repository,
    fetchMarkets: async () => [upcomingMarket, activeMarket],
    now: () => new Date(lastSyncedAt)
  });

  assert.deepEqual(result, {
    inserted: 1,
    updated: 0,
    totalUpcoming: 1
  });

  const stored = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(stored.markets.length, 1);
  assert.equal(stored.markets[0].marketId, upcomingMarket.id);
  assert.equal(stored.markets[0].ticker, upcomingMarket.ticker);
  assert.equal(stored.markets[0].status, "approved");
});
