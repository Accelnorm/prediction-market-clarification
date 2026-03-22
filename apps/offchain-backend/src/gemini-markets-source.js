export const DEFAULT_GEMINI_MARKETS_SOURCE_URL =
  "https://api.gemini.com/v1/prediction-markets/events?status=active&limit=500";

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
  sourceUrl = DEFAULT_GEMINI_MARKETS_SOURCE_URL,
  fetchImpl = fetch
} = {}) {
  if (isFileUrl(sourceUrl)) {
    throw new Error("Fixture file sources are no longer supported. Use the live Gemini API.");
  }

  return fetchMarketsFromEndpoint(sourceUrl, fetchImpl);
}
