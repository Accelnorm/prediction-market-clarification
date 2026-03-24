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

function isFileUrl(sourceUrl) {
  return sourceUrl.startsWith("file://");
}

function isPaginatedPayload(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    Array.isArray(payload.data) &&
    payload.pagination &&
    typeof payload.pagination === "object"
  );
}

function extractMarkets(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}

async function fetchJson(sourceUrl, fetchImpl) {
  const response = await fetchImpl(sourceUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch markets: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function buildPaginatedUrl(sourceUrl, offset) {
  const nextUrl = new URL(sourceUrl);

  if (!nextUrl.searchParams.has("limit")) {
    nextUrl.searchParams.set("limit", "500");
  }

  nextUrl.searchParams.set("offset", String(offset));
  return nextUrl.toString();
}

async function fetchMarketsFromEndpoint(sourceUrl, fetchImpl) {
  const firstPageUrl = buildPaginatedUrl(sourceUrl, Number(new URL(sourceUrl).searchParams.get("offset") ?? 0));
  const firstPayload = await fetchJson(firstPageUrl, fetchImpl);
  const firstBatch = extractMarkets(firstPayload);

  if (!isPaginatedPayload(firstPayload)) {
    return firstBatch;
  }

  const markets = [...firstBatch];
  const total = Number(firstPayload.pagination.total ?? firstBatch.length);
  let offset = Number(firstPayload.pagination.offset ?? 0) + firstBatch.length;

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

export async function fetchConfiguredMarkets({
  sourceUrl = DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL,
  fetchImpl = fetch
} = {}) {
  if (isFileUrl(sourceUrl)) {
    throw new Error("Fixture file sources are no longer supported. Use the live Gemini API.");
  }

  return fetchMarketsFromEndpoint(sourceUrl, fetchImpl);
}

export async function fetchActiveMarkets(options: any = {}) {
  return fetchConfiguredMarkets({
    ...options,
    sourceUrl: options.sourceUrl ?? DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL
  });
}

export async function fetchUpcomingMarkets(options: any = {}) {
  return fetchConfiguredMarkets({
    ...options,
    sourceUrl: options.sourceUrl ?? DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL
  });
}

export async function fetchNewlyListedMarkets(options: any = {}) {
  return fetchConfiguredMarkets({
    ...options,
    sourceUrl: options.sourceUrl ?? DEFAULT_GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL
  });
}

export async function fetchPredictionMarketEventByTicker(eventTicker, { fetchImpl = fetch } = {}) {
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
  fetchImpl = fetch
}: { status?: string[]; sourceUrl?: string; fetchImpl?: typeof fetch } = {}) {
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

  const payload = await response.json();
  return Array.isArray(payload?.categories) ? payload.categories : [];
}

export async function fetchTradesForSymbol(
  symbol,
  { timestamp = undefined as any, sinceTid = undefined as any, limitTrades = 500, includeBreaks = false, fetchImpl = fetch } = {}
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

export async function fetchEnrichedPredictionMarkets({
  fetchMarkets = fetchActiveMarkets,
  fetchEventByTicker = fetchPredictionMarketEventByTicker
} = {}) {
  const markets = await fetchMarkets();
  const enrichedMarkets: any[] = [];

  for (const market of markets) {
    if (typeof market?.ticker !== "string" || market.ticker.trim() === "") {
      enrichedMarkets.push(market);
      continue;
    }

    enrichedMarkets.push(await fetchEventByTicker(market.ticker));
  }

  return enrichedMarkets;
}
