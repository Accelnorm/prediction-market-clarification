import {
  normalizeGeminiMarket,
  sameNormalizedMarketShape
} from "./gemini-market-normalizer.js";
import type { MarketRecord } from "./types.js";

type SourceMarket = Record<string, unknown> & { id?: unknown; status?: unknown; createdAt?: unknown };

function isMarketWithStatus(market: SourceMarket, status: string) {
  if (typeof market?.status === "string") {
    return market.status.toLowerCase() === status;
  }

  return false;
}

function uniqueMarkets(markets: SourceMarket[] = []) {
  const dedupedById = new Map<string, SourceMarket>();

  for (const market of Array.isArray(markets) ? markets : []) {
    if (!market || typeof market.id === "undefined" || market.id === null) {
      continue;
    }

    dedupedById.set(String(market.id), market);
  }

  return [...dedupedById.values()];
}

type SyncState = {
  lastCreatedAt?: string | null;
  boundaryEventIds?: string[];
  lastSyncedAt?: string | null;
  updatedAt?: string | null;
};

function shouldKeepNewlyListedEvent({ sourceMarket, syncState }: { sourceMarket: SourceMarket; syncState: SyncState | null | undefined }) {
  const createdAt = typeof sourceMarket?.createdAt === "string" ? sourceMarket.createdAt : null;

  if (!createdAt || !syncState?.lastCreatedAt) {
    return true;
  }

  if (createdAt > syncState.lastCreatedAt) {
    return true;
  }

  if (createdAt < syncState.lastCreatedAt) {
    return false;
  }

  return !Array.isArray(syncState.boundaryEventIds) || !syncState.boundaryEventIds.includes(String(sourceMarket.id));
}

function buildNextSyncState({ sourceMarkets, syncedAt }: { sourceMarkets: SourceMarket[]; syncedAt: string }) {
  if (!Array.isArray(sourceMarkets) || sourceMarkets.length === 0) {
    return {
      lastCreatedAt: null,
      boundaryEventIds: [],
      lastSyncedAt: syncedAt,
      updatedAt: syncedAt
    };
  }

  const latestCreatedAt = sourceMarkets
    .map((market: SourceMarket) => (typeof market?.createdAt === "string" ? market.createdAt : null))
    .filter(Boolean)
    .sort((left: string | null, right: string | null) => (right as string).localeCompare(left as string))[0] ?? null;
  const boundaryEventIds = latestCreatedAt
    ? sourceMarkets
        .filter((market: SourceMarket) => market?.createdAt === latestCreatedAt)
        .map((market: SourceMarket) => String(market.id))
        .sort((left: string, right: string) => left.localeCompare(right))
    : [];

  return {
    lastCreatedAt: latestCreatedAt,
    boundaryEventIds,
    lastSyncedAt: syncedAt,
    updatedAt: syncedAt
  };
}

type MarketCacheRepository = {
  load: () => Promise<{ markets: MarketRecord[] }>;
  save: (markets: MarketRecord[]) => Promise<void>;
};

type SyncMarketSetOptions = {
  repository: MarketCacheRepository;
  fetchMarkets: () => Promise<unknown[]>;
  now?: () => Date;
  includeMarket?: (market: SourceMarket) => boolean;
  totalKey: string;
};

async function syncMarketSet({
  repository,
  fetchMarkets,
  now = () => new Date(),
  includeMarket = (() => true),
  totalKey
}: SyncMarketSetOptions) {
  const sourceMarkets = uniqueMarkets(await fetchMarkets() as SourceMarket[]);
  const matchingMarkets = sourceMarkets.filter(includeMarket);
  const cache = await repository.load();
  const marketsById = new Map(cache.markets.map((market: MarketRecord) => [market.marketId, market]));
  const lastSyncedAt = now().toISOString();

  let inserted = 0;
  let updated = 0;

  for (const sourceMarket of matchingMarkets) {
    const normalized = normalizeGeminiMarket(sourceMarket, lastSyncedAt);
    const existing = marketsById.get(normalized.marketId);

    if (!existing) {
      inserted += 1;
      marketsById.set(normalized.marketId, normalized);
      continue;
    }

    updated += 1;
    marketsById.set(
      normalized.marketId,
      sameNormalizedMarketShape(existing, normalized)
        ? { ...existing, lastSyncedAt }
        : normalized
    );
  }

  const markets = [...marketsById.values()].sort((left: MarketRecord, right: MarketRecord) =>
    left.marketId.localeCompare(right.marketId)
  );

  await repository.save(markets);

  return {
    inserted,
    updated,
    [totalKey]: matchingMarkets.length
  };
}

export type SyncMarketsOptions = {
  repository: MarketCacheRepository;
  fetchMarkets: () => Promise<unknown[]>;
  now?: () => Date;
};

export async function syncMarkets({ repository, fetchMarkets, now = () => new Date() }: SyncMarketsOptions) {
  return syncMarketSet({
    repository,
    fetchMarkets,
    now,
    includeMarket: (market: SourceMarket) => isMarketWithStatus(market, "active"),
    totalKey: "totalActive"
  });
}

export async function syncUpcomingMarkets({ repository, fetchMarkets, now = () => new Date() }: SyncMarketsOptions) {
  return syncMarketSet({
    repository,
    fetchMarkets,
    now,
    includeMarket: (market: SourceMarket) => isMarketWithStatus(market, "approved"),
    totalKey: "totalUpcoming"
  });
}

export type SyncMarketCategoriesOptions = {
  repository: { setCatalog: (scope: string, data: { categories: string[]; updatedAt: string | null }) => Promise<unknown> };
  fetchCategories: () => Promise<string[]>;
  scope: string;
  now?: () => Date;
};

export async function syncMarketCategories({
  repository,
  fetchCategories,
  scope,
  now = () => new Date()
}: SyncMarketCategoriesOptions) {
  const categories = await fetchCategories();
  return repository.setCatalog(scope, {
    categories,
    updatedAt: now().toISOString()
  });
}

export type SyncNewlyListedMarketsOptions = {
  activeRepository: MarketCacheRepository;
  upcomingRepository: MarketCacheRepository;
  fetchMarkets: () => Promise<unknown[]>;
  syncStateRepository: {
    getState: (scope: string) => Promise<SyncState | null | undefined>;
    setState: (scope: string, state: SyncState) => Promise<unknown>;
  };
  syncStateScope?: string;
  now?: () => Date;
};

export async function syncNewlyListedMarkets({
  activeRepository,
  upcomingRepository,
  fetchMarkets,
  syncStateRepository,
  syncStateScope = "markets:newly-listed",
  now = () => new Date()
}: SyncNewlyListedMarketsOptions) {
  const sourceMarkets = uniqueMarkets(await fetchMarkets() as SourceMarket[]);
  const syncState = await syncStateRepository.getState(syncStateScope);
  const candidates = sourceMarkets.filter((market: SourceMarket) =>
    shouldKeepNewlyListedEvent({
      sourceMarket: market,
      syncState
    })
  );
  const syncTimestamp = now().toISOString();
  const activeCache = await activeRepository.load();
  const upcomingCache = await upcomingRepository.load();
  const activeById = new Map(activeCache.markets.map((market: MarketRecord) => [market.marketId, market]));
  const upcomingById = new Map(upcomingCache.markets.map((market: MarketRecord) => [market.marketId, market]));

  let insertedActive = 0;
  let updatedActive = 0;
  let insertedUpcoming = 0;
  let updatedUpcoming = 0;

  for (const sourceMarket of candidates) {
    const normalized = normalizeGeminiMarket(sourceMarket, syncTimestamp);

    if (isMarketWithStatus(sourceMarket, "active")) {
      const existing = activeById.get(normalized.marketId);
      if (existing) {
        updatedActive += 1;
      } else {
        insertedActive += 1;
      }
      activeById.set(
        normalized.marketId,
        existing && sameNormalizedMarketShape(existing, normalized)
          ? { ...existing, lastSyncedAt: syncTimestamp }
          : normalized
      );
      continue;
    }

    if (isMarketWithStatus(sourceMarket, "approved")) {
      const existing = upcomingById.get(normalized.marketId);
      if (existing) {
        updatedUpcoming += 1;
      } else {
        insertedUpcoming += 1;
      }
      upcomingById.set(
        normalized.marketId,
        existing && sameNormalizedMarketShape(existing, normalized)
          ? { ...existing, lastSyncedAt: syncTimestamp }
          : normalized
      );
    }
  }

  await activeRepository.save([...activeById.values()]);
  await upcomingRepository.save([...upcomingById.values()]);
  await syncStateRepository.setState(
    syncStateScope,
    buildNextSyncState({ sourceMarkets, syncedAt: syncTimestamp })
  );

  return {
    insertedActive,
    updatedActive,
    insertedUpcoming,
    updatedUpcoming,
    totalNewlyListed: candidates.length
  };
}
