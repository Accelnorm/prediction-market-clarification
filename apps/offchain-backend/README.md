# Off-Chain Backend

This service exposes the Phase 1 paid clarification API, market sync jobs, health endpoints, and optional Telegram routes. Non-Phase-1 reviewer and crowdfunding routes remain available only when `ENABLE_PHASE2_REVIEWER_ROUTES=1`.

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

## Storage Modes

- Local/dev mode: file-backed JSON under `apps/offchain-backend/data`
- Demo/production mode: Postgres via `DATABASE_URL`

When `DATABASE_URL` is set, both `npm run start` and `npm run sync:markets` bootstrap the required Postgres schema automatically.

## Sync Markets

Local file-backed sync:

```bash
cd apps/offchain-backend
MARKET_CACHE_PATH="$PWD/data/market-cache.json" \
UPCOMING_MARKET_CACHE_PATH="$PWD/data/upcoming-market-cache.json" \
npm run sync:markets
```

Postgres-backed sync:

```bash
cd apps/offchain-backend
DATABASE_URL="postgres://<USER>:<PASS>@<HOST>:5432/<DB>" \
npm run sync:markets
```

## Start The API

Local/dev start:

```bash
cd apps/offchain-backend
PORT=3000 \
npm run start
```

Strict Phase 1 demo / production-style start:

```bash
cd apps/offchain-backend
DATABASE_URL="postgres://<USER>:<PASS>@<HOST>:5432/<DB>" \
APP_ENV="production" \
ENABLE_PHASE2_REVIEWER_ROUTES="0" \
ENABLE_TELEGRAM_ROUTES="0" \
LLM_PROVIDER="openrouter" \
OPENROUTER_API_KEY="replace-me" \
LLM_MODEL="openrouter/auto" \
X402_RECIPIENT_ADDRESS="<YOUR_SOLANA_USDC_RECIPIENT>" \
X402_FACILITATOR_AUTH_TOKEN="replace-me" \
PORT=3000 \
npm run start
```

## Health Endpoints

- `GET /health/live`
- `GET /health/ready`

Use `/health/ready` for deployment health checks. It verifies runtime readiness and database reachability when Postgres is enabled.

## Environment Variables

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
- `MARKET_CACHE_PATH`, `UPCOMING_MARKET_CACHE_PATH` for file-backed mode
- `CLARIFICATION_REQUESTS_PATH`, `VERIFIED_PAYMENTS_PATH`, `BACKGROUND_JOBS_PATH`
- `ARTIFACTS_PATH`, `REVIEWER_SCANS_PATH`, `UPCOMING_REVIEWER_SCANS_PATH`
- `LLM_PROMPT_TEMPLATE_VERSION`, `LLM_MODEL_ID`, `LLM_PROCESSING_VERSION`
- `PUBLIC_API_BASE_URL`
- `X402_VERSION`, `X402_SCHEME`, `X402_PRICE_USD`, `X402_MAX_AMOUNT_REQUIRED`
- `X402_ASSET_SYMBOL`, `X402_NETWORK`, `X402_MINT_ADDRESS`, `X402_RECIPIENT_ADDRESS`
- `X402_MAX_TIMEOUT_SECONDS`, `X402_FACILITATOR_URL`, `X402_FACILITATOR_AUTH_TOKEN`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_API_BASE_URL`

In production mode, startup fails closed if these are missing or invalid:

- `DATABASE_URL`
- a real LLM provider API key
- `X402_FACILITATOR_AUTH_TOKEN`
- a non-placeholder `X402_RECIPIENT_ADDRESS`
- complete Telegram webhook config when Telegram is enabled

## Quick API Check

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

Poll clarification status:

```bash
curl http://127.0.0.1:3000/api/clarifications/<CLARIFICATION_ID>
```

## Telegram

Telegram is optional and disabled by default. To enable it:

```bash
ENABLE_TELEGRAM_ROUTES="1"
TELEGRAM_BOT_TOKEN="<TELEGRAM_BOT_TOKEN>"
TELEGRAM_WEBHOOK_URL="https://<YOUR_DOMAIN>/api/telegram/webhook"
TELEGRAM_WEBHOOK_SECRET="<TELEGRAM_WEBHOOK_SECRET>"
```

With Telegram enabled, the server registers the webhook on boot. Telegram remains an intake and status-delivery path only.

## Hackathon Demo Readiness

For a hackathon demo, the backend is ready if you deploy it with:

- Postgres enabled via `DATABASE_URL`
- production mode enabled
- a real LLM provider key
- a real x402 facilitator token and recipient address
- Phase 2 routes disabled
- Telegram disabled unless you explicitly want it in the demo

The main remaining gap is deployment ergonomics. The service does not yet ship with a Dockerfile or platform template, so deployment is still “manual Node process plus Postgres” rather than one-click.
