# Off-Chain Backend

This service exposes the clarification API, reviewer endpoints, market sync job, and Telegram webhook intake.

## Install

```bash
cd apps/offchain-backend
npm install
```

## Test

```bash
cd apps/offchain-backend
npm test
```

The passing suite covers market sync, paid clarifications, reviewer workflows, and Telegram webhook request handling.

## Sync Markets

```bash
cd apps/offchain-backend
MARKET_CACHE_PATH="$PWD/data/market-cache.json" \
UPCOMING_MARKET_CACHE_PATH="$PWD/data/upcoming-market-cache.json" \
npm run sync:markets
```

## Start The API

```bash
cd apps/offchain-backend
REVIEWER_AUTH_TOKEN="reviewer-secret" \
PORT=3000 \
npm run start
```

Environment variables:

- `PORT`, `HOST`
- `REVIEWER_AUTH_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_BOT_API_BASE_URL`
- `LLM_PROVIDER`: `openrouter` by default, plus `openai-compatible` and `anthropic-compatible`
- `LLM_MODEL`
- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`
- `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_VERSION`
- `MARKET_CACHE_PATH`, `UPCOMING_MARKET_CACHE_PATH`
- `CLARIFICATION_REQUESTS_PATH`, `VERIFIED_PAYMENTS_PATH`, `BACKGROUND_JOBS_PATH`
- `ARTIFACTS_PATH`, `REVIEWER_SCANS_PATH`, `UPCOMING_REVIEWER_SCANS_PATH`
- `LLM_PROMPT_TEMPLATE_VERSION`, `LLM_MODEL_ID`, `LLM_PROCESSING_VERSION`
- `PUBLIC_API_BASE_URL`
- `X402_VERSION`, `X402_SCHEME`, `X402_PRICE_USD`, `X402_MAX_AMOUNT_REQUIRED`
- `X402_ASSET_SYMBOL`, `X402_NETWORK`, `X402_MINT_ADDRESS`, `X402_RECIPIENT_ADDRESS`
- `X402_MAX_TIMEOUT_SECONDS`, `X402_FACILITATOR_URL`, `X402_FACILITATOR_AUTH_TOKEN`

## Quick API Checks

Request the x402 payment challenge:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

Retry with a paid x402 proof in `PAYMENT-SIGNATURE`:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payment-payload>' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

Read reviewer queue:

```bash
curl http://127.0.0.1:3000/api/reviewer/queue \
  -H 'x-reviewer-token: reviewer-secret'
```

## Telegram Setup

To auto-register your deployed webhook on startup, set:

```bash
TELEGRAM_BOT_TOKEN="<TELEGRAM_BOT_TOKEN>"
TELEGRAM_WEBHOOK_URL="https://<YOUR_DOMAIN>/api/telegram/webhook"
TELEGRAM_WEBHOOK_SECRET="<TELEGRAM_WEBHOOK_SECRET>"
```

Then send your bot:

```text
/clarify gm_btc_above_100k Should auction prints count?
```

Look up stored requests:

```bash
curl "https://<YOUR_DOMAIN>/api/telegram/requests?chat_id=<CHAT_ID>&user_id=<USER_ID>"
```

Simulate a completed status:

```bash
curl -X POST "https://<YOUR_DOMAIN>/api/telegram/requests/<REQUEST_ID>/status" \
  -H 'content-type: application/json' \
  -d '{
    "status": "completed",
    "clarificationId": "clar_001",
    "summary": "Gemini auction and spot prints both count toward resolution."
  }'
```

## Missing Pieces

- The LLM path falls back to the local deterministic stub when no provider API key is configured
- File-backed persistence only
