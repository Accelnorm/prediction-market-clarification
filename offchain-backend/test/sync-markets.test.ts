// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";

import { FileCategoryCatalogRepository } from "../src/category-catalog-repository.js";
import { FileMarketCacheRepository } from "../src/market-cache-repository.js";
import { FileSyncStateRepository } from "../src/sync-state-repository.js";
import {
  syncMarketCategories,
  syncMarkets,
  syncNewlyListedMarkets,
  syncUpcomingMarkets
} from "../src/sync-markets.js";

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
    createdAt: null,
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
  assert.equal(stored.markets[0].createdAt, null);
});

test("syncNewlyListedMarkets incrementally inserts only unseen events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "newly-listed-sync-"));
  const activeRepository = new FileMarketCacheRepository(path.join(tempDir, "active.json"));
  const upcomingRepository = new FileMarketCacheRepository(path.join(tempDir, "upcoming.json"));
  const syncStateRepository = new FileSyncStateRepository(path.join(tempDir, "sync-state.json"));

  await activeRepository.save([
    {
      marketId: "gm_existing",
      title: "Existing",
      description: "",
      resolution: "Existing",
      resolutionText: "Existing",
      closesAt: "",
      endTime: "",
      slug: null,
      url: null,
      category: null,
      subcategory: null,
      status: "active",
      createdAt: "2026-03-20T00:00:00.000Z",
      effectiveDate: null,
      expiryDate: null,
      resolvedAt: null,
      termsLink: null,
      tags: [],
      contracts: [],
      lastSyncedAt: "2026-03-20T00:00:00.000Z"
    }
  ]);
  await syncStateRepository.setState("markets:newly-listed", {
    lastCreatedAt: "2026-03-21T00:00:00.000Z",
    boundaryEventIds: ["gm_existing"],
    lastSyncedAt: "2026-03-21T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z"
  });

  const result = await syncNewlyListedMarkets({
    activeRepository,
    upcomingRepository,
    syncStateRepository,
    now: () => new Date("2026-03-22T00:00:00.000Z"),
    fetchMarkets: async () => [
      {
        ...activeMarket,
        id: "gm_existing",
        createdAt: "2026-03-21T00:00:00.000Z"
      },
      {
        ...upcomingMarket,
        id: "gm_new_upcoming",
        createdAt: "2026-03-22T00:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(result, {
    insertedActive: 0,
    updatedActive: 0,
    insertedUpcoming: 1,
    updatedUpcoming: 0,
    totalNewlyListed: 1
  });

  const storedUpcoming = JSON.parse(await readFile(path.join(tempDir, "upcoming.json"), "utf8"));
  assert.equal(storedUpcoming.markets.length, 1);
  assert.equal(storedUpcoming.markets[0].marketId, "gm_new_upcoming");
});

test("syncMarketCategories stores normalized category catalogs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "category-sync-"));
  const repository = new FileCategoryCatalogRepository(path.join(tempDir, "categories.json"));

  const catalog = await syncMarketCategories({
    repository,
    scope: "active",
    now: () => new Date("2026-03-22T00:00:00.000Z"),
    fetchCategories: async () => ["sports", "crypto", "sports"]
  });

  assert.deepEqual(catalog, {
    categories: ["crypto", "sports"],
    updatedAt: "2026-03-22T00:00:00.000Z"
  });
});
