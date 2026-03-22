# Oracle's Wake-Up Call

This repo currently centers on an API-first off-chain clarification service for prediction markets. Phase 1 is the paid clarification primitive itself: x402-gated request creation, asynchronous LLM processing, public status lookup, market sync, and optional Telegram intake.

## Phase 1 Scope

Phase 1 is:

- paid off-chain clarification via API
- real x402 payment verification
- asynchronous LLM processing with public status lookup

The public web UI is not required for this cutoff. If Gemini adopts the idea, the requester-facing experience would likely live inside Gemini's own product surface, while external agents can call this API directly.

Telegram is not part of the default Phase 1 runtime. It remains an optional intake and status-delivery channel, gated behind `ENABLE_TELEGRAM_ROUTES=1`, and it does not perform x402 payment natively.

## What Works Today

- Gemini market sync into file-backed or Postgres-backed caches
- Incremental Gemini market ingest from newly listed events with dedupe by `marketId`
- Official Gemini category catalog sync for validation and reviewer queue metadata
- Paid clarification API flow with durable background-job persistence
- Crash recovery for queued and in-flight clarification jobs on server startup
- Clarification timing with configurable static or dynamic finality windows
- Health endpoints at `GET /health/live` and `GET /health/ready`
- Request ID logging and rate limiting on the public clarify endpoint
- Optional Phase 2 reviewer routes behind `ENABLE_PHASE2_REVIEWER_ROUTES=1`
- Optional Telegram intake and outbound delivery behind `ENABLE_TELEGRAM_ROUTES=1`

## Gemini API Usage

This repo currently uses these Gemini API endpoints:

- `GET /v1/prediction-markets/events?status=active&limit=500`
  - authoritative full sync for active events
  - refreshes the active market cache in file-backed or Postgres-backed storage
- `GET /v1/prediction-markets/events/upcoming?limit=500`
  - authoritative full sync for approved or upcoming events
  - refreshes the upcoming market cache used by prelaunch and reviewer flows
- `GET /v1/prediction-markets/events/newly-listed?limit=500`
  - incremental ingest path between full syncs
  - reduces full-cache refetching and upserts events by `marketId` so reruns stay idempotent
- `GET /v1/prediction-markets/events/{ticker}`
  - targeted refresh for a single event when the backend needs to rehydrate or confirm a market by ticker
- `GET /v1/prediction-markets/categories`
  - syncs Gemini's official category catalog
  - used to validate cached categories and expose `availableCategories` in reviewer and prelaunch queue payloads
- `GET /v1/trades/{instrumentSymbol}`
  - used only for clarification lifecycle timing
  - refreshes trade activity while the LLM clarification job is running for active markets
  - supports dynamic finality windows after a clarification is produced

No Gemini order-management endpoints are used. This project is clarification-only.

## What Is Tested

The backend test suite passes locally:

```bash
cd offchain-backend
npm install
npm test
```

Automated coverage includes:

- Gemini market sync normalization
- Paid clarification creation, deduplication, and retry behavior
- Health endpoints and route gating for disabled Phase 2 / Telegram routes
- Reviewer routes when explicitly enabled
- Telegram webhook parsing, persistence, lookup, and status update payloads
- Production config validation

Important limitation: Telegram coverage is still HTTP-level only. The code is tested for receiving Telegram-style webhook payloads and producing status messages, but not end-to-end against the live Telegram Bot API.

## Local Run

Sync market data:

```bash
cd offchain-backend
MARKET_CACHE_PATH="$PWD/data/market-cache.json" \
UPCOMING_MARKET_CACHE_PATH="$PWD/data/upcoming-market-cache.json" \
npm run sync:markets
```

Start the API locally:

```bash
cd offchain-backend
PORT=3000 \
npm run start
```

Without `DATABASE_URL`, the backend stores state in file-backed JSON under `offchain-backend/data`. With `DATABASE_URL`, the API and market sync CLIs bootstrap the Postgres schema automatically and use Postgres-backed repositories.

Useful environment variables:

- `PORT`, `HOST`
- `DATABASE_URL`
- `APP_ENV` or `NODE_ENV`
- `ENABLE_PHASE2_REVIEWER_ROUTES`
- `ENABLE_TELEGRAM_ROUTES`
- `REVIEWER_AUTH_TOKEN` when Phase 2 routes are enabled
- `LLM_PROVIDER`, `LLM_MODEL`
- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`
- `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_VERSION`
- `PUBLIC_API_BASE_URL`
- `SYNC_STATE_PATH`, `CATEGORY_CATALOG_PATH`, `TRADE_ACTIVITY_PATH` for file-backed Gemini sync state
- `CLARIFICATION_FINALITY_MODE`
- `CLARIFICATION_FINALITY_STATIC_SECS`
- `CLARIFICATION_PROCESSING_ACTIVITY_ENABLED`
- `X402_VERSION`, `X402_SCHEME`, `X402_PRICE_USD`, `X402_MAX_AMOUNT_REQUIRED`
- `X402_ASSET_SYMBOL`, `X402_NETWORK`, `X402_MINT_ADDRESS`, `X402_RECIPIENT_ADDRESS`
- `X402_MAX_TIMEOUT_SECONDS`, `X402_FACILITATOR_URL`, `X402_FACILITATOR_AUTH_TOKEN`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_API_BASE_URL`

Clarification timing modes:

- `CLARIFICATION_FINALITY_MODE=static`
  - every clarification uses the same finality window
  - default fixed value comes from `CLARIFICATION_FINALITY_STATIC_SECS` and defaults to `86400`
- `CLARIFICATION_FINALITY_MODE=dynamic`
  - finality is shortened for more important or actively traded markets using Gemini trade history plus market metadata
  - in-flight LLM jobs can also refresh trade activity when `CLARIFICATION_PROCESSING_ACTIVITY_ENABLED=1`

## Manual API Check

1. Request the x402 payment challenge:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

2. Retry with a paid proof in `PAYMENT-SIGNATURE`:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payment-payload>' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

3. Poll clarification status:

```bash
curl http://127.0.0.1:3000/api/clarifications/<CLARIFICATION_ID>
```

## Hackathon Demo Path

For a hackathon demo, the easiest deployment path is:

1. One Node service running `offchain-backend`
2. One Postgres database
3. Phase 2 routes disabled: `ENABLE_PHASE2_REVIEWER_ROUTES=0`
4. Telegram disabled unless you actively want it in the demo: `ENABLE_TELEGRAM_ROUTES=0`
5. A startup job or manual step running `npm run sync:markets`
6. Demo traffic hitting:
   - `POST /api/clarify/:eventId`
   - `GET /api/clarifications/:clarificationId`

Minimal demo env:

```bash
DATABASE_URL="postgres://<USER>:<PASS>@<HOST>:5432/<DB>"
APP_ENV="production"
ENABLE_PHASE2_REVIEWER_ROUTES="0"
ENABLE_TELEGRAM_ROUTES="0"
LLM_PROVIDER="openrouter"
OPENROUTER_API_KEY="replace-me"
LLM_MODEL="openrouter/auto"
X402_RECIPIENT_ADDRESS="<YOUR_SOLANA_USDC_RECIPIENT>"
X402_FACILITATOR_AUTH_TOKEN="replace-me"
PORT="3000"
```

That is enough for a hackathon demo as long as:

- market sync has run successfully
- the x402 facilitator token is valid
- the LLM provider key is valid
- your deployment points to a working Postgres instance

## Telegram

Telegram is optional and off by default. If you want it for a demo, explicitly enable it and provide the full webhook config:

```bash
ENABLE_TELEGRAM_ROUTES="1"
TELEGRAM_BOT_TOKEN="<TELEGRAM_BOT_TOKEN>"
TELEGRAM_WEBHOOK_URL="https://<YOUR_DOMAIN>/api/telegram/webhook"
TELEGRAM_WEBHOOK_SECRET="<TELEGRAM_WEBHOOK_SECRET>"
```

When Telegram is enabled, the server registers the webhook on boot. Telegram remains an intake and status-delivery channel only; it does not perform x402 payment natively.

## Status

This backend is ready for a hackathon demo if you deploy it with Postgres, production-mode env vars, and Phase 2 routes disabled. It is not yet packaged into a one-command demo deployment like Docker or a platform template, so the main remaining gap is deployment ergonomics rather than core API functionality.
