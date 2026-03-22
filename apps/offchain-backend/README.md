# Off-Chain Backend

Minimal reviewer-first backend slices land here.

## Market sync

Run the market ingestion process against a configured Gemini Prediction Markets source:

```bash
GEMINI_MARKETS_SOURCE_URL="file:///home/user/gemini-pm/apps/offchain-backend/fixtures/gemini-active-markets.json" \
MARKET_CACHE_PATH="/home/user/gemini-pm/apps/offchain-backend/data/market-cache.json" \
npm run sync:markets
```

The sync stores a normalized off-chain read model and updates existing market records idempotently by `marketId`.
