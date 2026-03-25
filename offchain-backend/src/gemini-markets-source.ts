const GEMINI_API_BASE_URL = "https://api.gemini.com";
const DEFAULT_PAGE_LIMIT = "500";

export const DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL =
  `${GEMINI_API_BASE_URL}/v1/prediction-markets/events?status=active&limit=${DEFAULT_PAGE_LIMIT}`;
export const DEFAULT_GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL =
  `${GEMINI_API_BASE_URL}/v1/prediction-markets/events/newly-listed?limit=${DEFAULT_PAGE_LIMIT}`;
export const DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL =
  `${GEMINI_API_BASE_URL}/v1/prediction-markets/events/upcoming?limit=${DEFAULT_PAGE_LIMIT}`;
export const DEFAULT_GEMINI_CATEGORIES_SOURCE_URL =
  `${GEMINI_API_BASE_URL}/v1/prediction-markets/categories`;

function isFileUrl(sourceUrl: string) {
  return sourceUrl.startsWith("file://");
}

function isPaginatedPayload(payload: unknown) {
  return (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as Record<string, unknown>).data) &&
    (payload as Record<string, unknown>).pagination &&
    typeof (payload as Record<string, unknown>).pagination === "object"
  );
}

function extractMarkets(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object") {
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      return data;
    }
  }

  return [];
}

async function fetchJson(sourceUrl: string, fetchImpl: FetchLike) {
  const response = await fetchImpl(sourceUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch markets: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function buildPaginatedUrl(sourceUrl: string, offset: number) {
  const nextUrl = new URL(sourceUrl);

  if (!nextUrl.searchParams.has("limit")) {
    nextUrl.searchParams.set("limit", "500");
  }

  nextUrl.searchParams.set("offset", String(offset));
  return nextUrl.toString();
}

async function fetchMarketsFromEndpoint(sourceUrl: string, fetchImpl: FetchLike) {
  const firstPageUrl = buildPaginatedUrl(sourceUrl, Number(new URL(sourceUrl).searchParams.get("offset") ?? 0));
  const firstPayload = await fetchJson(firstPageUrl, fetchImpl);
  const firstBatch = extractMarkets(firstPayload);

  if (!isPaginatedPayload(firstPayload)) {
    return firstBatch;
  }

  const paginatedFirst = firstPayload as Record<string, Record<string, unknown>>;
  const markets = [...firstBatch];
  const total = Number(paginatedFirst.pagination.total ?? firstBatch.length);
  let offset = Number(paginatedFirst.pagination.offset ?? 0) + firstBatch.length;

  while (offset < total) {
    const pageUrl = buildPaginatedUrl(sourceUrl, offset);
    const pagePayload = await fetchJson(pageUrl, fetchImpl);
    const batch = extractMarkets(pagePayload);

    if (batch.length === 0) {
      break;
    }

    markets.push(...batch);
    offset += batch.length;
  }

  return markets;
}

type FetchResponse = { ok: boolean; status?: number; statusText?: string; json: () => Promise<unknown> };
type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;

export type FetchMarketsOptions = {
  sourceUrl?: string;
  fetchImpl?: FetchLike;
};

export async function fetchConfiguredMarkets({
  sourceUrl = DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL,
  fetchImpl = fetch as FetchLike
}: FetchMarketsOptions = {}) {
  if (isFileUrl(sourceUrl)) {
    throw new Error("Fixture file sources are no longer supported. Use the live Gemini API.");
  }

  return fetchMarketsFromEndpoint(sourceUrl, fetchImpl);
}

export async function fetchActiveMarkets(options: FetchMarketsOptions = {}) {
  return fetchConfiguredMarkets({
    ...options,
    sourceUrl: options.sourceUrl ?? DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL
  });
}

export async function fetchUpcomingMarkets(options: FetchMarketsOptions = {}) {
  return fetchConfiguredMarkets({
    ...options,
    sourceUrl: options.sourceUrl ?? DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL
  });
}

export async function fetchNewlyListedMarkets(options: FetchMarketsOptions = {}) {
  return fetchConfiguredMarkets({
    ...options,
    sourceUrl: options.sourceUrl ?? DEFAULT_GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL
  });
}

export async function fetchPredictionMarketEventByTicker(eventTicker: string, { fetchImpl = fetch as FetchLike }: { fetchImpl?: FetchLike } = {}) {
  const response = await fetchImpl(
    `${GEMINI_API_BASE_URL}/v1/prediction-markets/events/${encodeURIComponent(eventTicker)}`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Gemini event ${eventTicker}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function fetchPredictionMarketCategories({
  status = [] as string[],
  sourceUrl = DEFAULT_GEMINI_CATEGORIES_SOURCE_URL,
  fetchImpl = fetch as FetchLike
}: { status?: string[]; sourceUrl?: string; fetchImpl?: FetchLike } = {}) {
  const nextUrl = new URL(sourceUrl);

  for (const statusValue of Array.isArray(status) ? status : []) {
    if (typeof statusValue === "string" && statusValue.trim() !== "") {
      nextUrl.searchParams.append("status", statusValue.trim());
    }
  }

  const response = await fetchImpl(nextUrl.toString());

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Gemini categories: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json() as Record<string, unknown>;
  return Array.isArray(payload?.categories) ? payload.categories : [];
}

export type FetchTradesOptions = {
  timestamp?: number | null;
  sinceTid?: number | null;
  limitTrades?: number;
  includeBreaks?: boolean;
  fetchImpl?: FetchLike;
};

export async function fetchTradesForSymbol(
  symbol: string,
  { timestamp = undefined as number | null | undefined, sinceTid = undefined as number | null | undefined, limitTrades = 500, includeBreaks = false, fetchImpl = fetch as FetchLike }: FetchTradesOptions = {}
) {
  const nextUrl = new URL(`${GEMINI_API_BASE_URL}/v1/trades/${encodeURIComponent(symbol)}`);

  if (timestamp !== undefined && timestamp !== null) {
    nextUrl.searchParams.set("timestamp", String(timestamp));
  }

  if (sinceTid !== undefined && sinceTid !== null) {
    nextUrl.searchParams.set("since_tid", String(sinceTid));
  }

  if (limitTrades !== undefined && limitTrades !== null) {
    nextUrl.searchParams.set("limit_trades", String(limitTrades));
  }

  if (includeBreaks) {
    nextUrl.searchParams.set("include_breaks", "true");
  }

  const response = await fetchImpl(nextUrl.toString());

  if (!response.ok) {
    throw new Error(`Failed to fetch Gemini trades for ${symbol}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

export type FetchEnrichedMarketsOptions = {
  fetchMarkets?: () => Promise<unknown[]>;
  fetchEventByTicker?: (ticker: string) => Promise<unknown>;
};

export async function fetchEnrichedPredictionMarkets({
  fetchMarkets = fetchActiveMarkets,
  fetchEventByTicker = fetchPredictionMarketEventByTicker
}: FetchEnrichedMarketsOptions = {}) {
  const markets = await fetchMarkets();
  const enrichedMarkets: unknown[] = [];

  for (const market of markets) {
    if (typeof (market as Record<string, unknown>)?.ticker !== "string" || ((market as Record<string, unknown>).ticker as string).trim() === "") {
      enrichedMarkets.push(market);
      continue;
    }

    enrichedMarkets.push(await fetchEventByTicker((market as Record<string, unknown>).ticker as string));
  }

  return enrichedMarkets;
}
