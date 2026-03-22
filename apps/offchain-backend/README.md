# Off-Chain Backend

Minimal reviewer-first backend slices land here.

## Market sync

Run the market ingestion process against the live Gemini Prediction Markets API:

```bash
MARKET_CACHE_PATH="/home/user/gemini-pm/apps/offchain-backend/data/market-cache.json" \
npm run sync:markets
```

By default this calls `GET https://api.gemini.com/v1/prediction-markets/events?status=active&limit=500`
and follows Gemini's paginated `data`/`pagination` response until all active events are synced.

The sync stores a normalized off-chain read model and updates existing market records idempotently by `marketId`.
