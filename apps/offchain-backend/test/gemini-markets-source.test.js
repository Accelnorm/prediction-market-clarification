import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL,
  DEFAULT_GEMINI_CATEGORIES_SOURCE_URL,
  DEFAULT_GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL,
  DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL,
  fetchActiveMarkets,
  fetchConfiguredMarkets,
  fetchEnrichedPredictionMarkets,
  fetchNewlyListedMarkets,
  fetchPredictionMarketEventByTicker,
  fetchPredictionMarketCategories,
  fetchTradesForSymbol,
  fetchUpcomingMarkets
} from "../src/gemini-markets-source.js";

test("fetchActiveMarkets defaults to the live Gemini active markets endpoint", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        data: [{ id: "evt_1", status: "active" }],
        pagination: { offset: 0, limit: 500, total: 1 }
      })
    };
  };

  const markets = await fetchActiveMarkets({ fetchImpl });

  assert.deepEqual(markets, [{ id: "evt_1", status: "active" }]);
  assert.deepEqual(requests, [DEFAULT_GEMINI_ACTIVE_MARKETS_SOURCE_URL + "&offset=0"]);
});

test("fetchConfiguredMarkets follows paginated Gemini event responses", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);

    if (url.endsWith("offset=0")) {
      return {
        ok: true,
        json: async () => ({
          data: [{ id: "evt_1" }, { id: "evt_2" }],
          pagination: { offset: 0, limit: 2, total: 3 }
        })
      };
    }

    return {
      ok: true,
      json: async () => ({
        data: [{ id: "evt_3" }],
        pagination: { offset: 2, limit: 2, total: 3 }
      })
    };
  };

  const markets = await fetchConfiguredMarkets({
    sourceUrl: "https://api.gemini.com/v1/prediction-markets/events?status=active&limit=2",
    fetchImpl
  });

  assert.deepEqual(markets, [{ id: "evt_1" }, { id: "evt_2" }, { id: "evt_3" }]);
  assert.deepEqual(requests, [
    "https://api.gemini.com/v1/prediction-markets/events?status=active&limit=2&offset=0",
    "https://api.gemini.com/v1/prediction-markets/events?status=active&limit=2&offset=2"
  ]);
});

test("fetchUpcomingMarkets defaults to the live Gemini upcoming markets endpoint", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        data: [{ id: "evt_up_1", status: "approved" }],
        pagination: { offset: 0, limit: 500, total: 1 }
      })
    };
  };

  const markets = await fetchUpcomingMarkets({ fetchImpl });

  assert.deepEqual(markets, [{ id: "evt_up_1", status: "approved" }]);
  assert.deepEqual(requests, [DEFAULT_GEMINI_UPCOMING_MARKETS_SOURCE_URL + "&offset=0"]);
});

test("fetchNewlyListedMarkets defaults to the live Gemini newly-listed endpoint", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        data: [{ id: "evt_new_1", status: "approved" }],
        pagination: { offset: 0, limit: 500, total: 1 }
      })
    };
  };

  const markets = await fetchNewlyListedMarkets({ fetchImpl });

  assert.deepEqual(markets, [{ id: "evt_new_1", status: "approved" }]);
  assert.deepEqual(requests, [DEFAULT_GEMINI_NEWLY_LISTED_MARKETS_SOURCE_URL + "&offset=0"]);
});

test("fetchPredictionMarketEventByTicker requests the Gemini detail endpoint", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        id: "evt_1",
        ticker: "BTC100K2025"
      })
    };
  };

  const market = await fetchPredictionMarketEventByTicker("BTC100K2025", { fetchImpl });

  assert.deepEqual(market, {
    id: "evt_1",
    ticker: "BTC100K2025"
  });
  assert.deepEqual(requests, [
    "https://api.gemini.com/v1/prediction-markets/events/BTC100K2025"
  ]);
});

test("fetchPredictionMarketCategories requests Gemini categories with status filters", async () => {
  const requests = [];
  const categories = await fetchPredictionMarketCategories({
    status: ["active", "approved"],
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({
          categories: ["crypto", "sports"]
        })
      };
    }
  });

  assert.deepEqual(categories, ["crypto", "sports"]);
  assert.equal(
    requests[0],
    `${DEFAULT_GEMINI_CATEGORIES_SOURCE_URL}?status=active&status=approved`
  );
});

test("fetchTradesForSymbol requests Gemini trades with cursor params", async () => {
  const requests = [];
  const trades = await fetchTradesForSymbol("GEMI-BTC-YES", {
    sinceTid: 123,
    limitTrades: 250,
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => [{ tid: 124, amount: "10", timestampms: 1770000000000 }]
      };
    }
  });

  assert.deepEqual(trades, [{ tid: 124, amount: "10", timestampms: 1770000000000 }]);
  assert.equal(
    requests[0],
    "https://api.gemini.com/v1/trades/GEMI-BTC-YES?since_tid=123&limit_trades=250"
  );
});

test("fetchEnrichedPredictionMarkets hydrates list results with per-event Gemini detail", async () => {
  const enrichedMarkets = await fetchEnrichedPredictionMarkets({
    fetchMarkets: async () => [
      { id: "evt_1", ticker: "BTC100K2025" },
      { id: "evt_2", ticker: "ETH5K2025" }
    ],
    fetchEventByTicker: async (ticker) => ({
      id: ticker === "BTC100K2025" ? "evt_1" : "evt_2",
      ticker,
      title: `${ticker} detail`
    })
  });

  assert.deepEqual(enrichedMarkets, [
    { id: "evt_1", ticker: "BTC100K2025", title: "BTC100K2025 detail" },
    { id: "evt_2", ticker: "ETH5K2025", title: "ETH5K2025 detail" }
  ]);
});

test("fetchConfiguredMarkets rejects fixture file sources", async () => {
  await assert.rejects(
    () =>
      fetchConfiguredMarkets({
        sourceUrl: "file:///tmp/gemini-active-markets.json"
      }),
    /Fixture file sources are no longer supported/
  );
});
