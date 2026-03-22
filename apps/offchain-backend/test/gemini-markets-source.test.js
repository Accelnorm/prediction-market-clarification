import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GEMINI_MARKETS_SOURCE_URL,
  fetchConfiguredMarkets
} from "../src/gemini-markets-source.js";

test("fetchConfiguredMarkets defaults to the live Gemini prediction markets endpoint", async () => {
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

  const markets = await fetchConfiguredMarkets({ fetchImpl });

  assert.deepEqual(markets, [{ id: "evt_1", status: "active" }]);
  assert.deepEqual(requests, [DEFAULT_GEMINI_MARKETS_SOURCE_URL + "&offset=0"]);
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

test("fetchConfiguredMarkets rejects fixture file sources", async () => {
  await assert.rejects(
    () =>
      fetchConfiguredMarkets({
        sourceUrl: "file:///tmp/gemini-active-markets.json"
      }),
    /Fixture file sources are no longer supported/
  );
});
