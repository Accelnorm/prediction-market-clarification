# Off-Chain Backend

Minimal reviewer-first backend slices land here.

## Market sync

Run the market ingestion process against the live Gemini Prediction Markets API:

```bash
MARKET_CACHE_PATH="/home/user/gemini-pm/apps/offchain-backend/data/market-cache.json" \
UPCOMING_MARKET_CACHE_PATH="/home/user/gemini-pm/apps/offchain-backend/data/upcoming-market-cache.json" \
npm run sync:markets
```

By default this:

- lists active events from `GET https://api.gemini.com/v1/prediction-markets/events?status=active&limit=500`
- lists upcoming events from `GET https://api.gemini.com/v1/prediction-markets/events/upcoming?limit=500`
- hydrates each listed event through `GET /v1/prediction-markets/events/{eventTicker}`
- stores separate active and upcoming normalized read models keyed by Gemini event id

The sync stores clarification-relevant Gemini event detail including category metadata, terms links,
and contract arrays, and updates existing market records idempotently by `marketId`.
