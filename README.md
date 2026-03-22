# Oracle's Wake-Up Call

This repo currently centers on the off-chain backend for clarification intake, reviewer workflows, market sync, and Telegram-facing request ingestion.

## What Works Today

- Gemini market sync into local file-backed caches
- Paid clarification API flow with background-job persistence
- Reviewer queue, scans, funding, audit, and finalization endpoints
- Telegram webhook intake for `/clarify <market_id> <question>`
- Telegram request lookup and status-payload generation

## What Is Actually Tested

The backend test suite passes locally:

```bash
cd apps/offchain-backend
npm install
npm test
```

Current automated coverage includes:

- Gemini market sync normalization
- Paid clarification creation and deduplication
- Reviewer queue, scan, funding, audit, and finalization routes
- Telegram webhook parsing, persistence, lookup, and status update payloads

Important limitation: the Telegram coverage is HTTP-level only. The code is tested for receiving Telegram-style webhook payloads and producing status messages, but it is not yet tested end-to-end against the live Telegram Bot API.

## Run The API Locally

Start by syncing market data:

```bash
cd apps/offchain-backend
MARKET_CACHE_PATH="$PWD/data/market-cache.json" \
UPCOMING_MARKET_CACHE_PATH="$PWD/data/upcoming-market-cache.json" \
npm run sync:markets
```

Then start the API:

```bash
cd apps/offchain-backend
REVIEWER_AUTH_TOKEN="reviewer-secret" \
PORT=3000 \
npm run start
```

Useful environment variables:

- `PORT` and `HOST` control the HTTP listener
- `REVIEWER_AUTH_TOKEN` protects reviewer-only routes
- `TELEGRAM_WEBHOOK_SECRET` validates Telegram webhook requests
- `TELEGRAM_BOT_TOKEN` enables live outbound Telegram delivery
- `TELEGRAM_WEBHOOK_URL` auto-registers the webhook on startup when set
- `TELEGRAM_BOT_API_BASE_URL` overrides the Telegram API base URL when needed
- `LLM_PROVIDER` defaults to `openrouter` and also supports `openai-compatible` and `anthropic-compatible`
- `LLM_MODEL` selects the model sent to the provider
- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`
- `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_VERSION`
- `MARKET_CACHE_PATH`, `UPCOMING_MARKET_CACHE_PATH`
- `CLARIFICATION_REQUESTS_PATH`, `BACKGROUND_JOBS_PATH`
- `ARTIFACTS_PATH`, `REVIEWER_SCANS_PATH`, `UPCOMING_REVIEWER_SCANS_PATH`

By default the backend stores state in JSON files under `apps/offchain-backend/data`.

## Test The API Manually

1. Sync markets and start the API.
2. Request the x402 payment challenge:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

3. Retry with a paid proof in `PAYMENT-SIGNATURE`:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payment-payload>' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

4. Read reviewer data:

```bash
curl http://127.0.0.1:3000/api/reviewer/queue \
  -H 'x-reviewer-token: reviewer-secret'
```

## Deploy The API

The backend is now runnable as a plain Node process:

```bash
cd apps/offchain-backend
npm install
MARKET_CACHE_PATH="$PWD/data/market-cache.json" \
UPCOMING_MARKET_CACHE_PATH="$PWD/data/upcoming-market-cache.json" \
REVIEWER_AUTH_TOKEN="replace-me" \
LLM_PROVIDER="openrouter" \
OPENROUTER_API_KEY="replace-me" \
LLM_MODEL="openrouter/auto" \
TELEGRAM_WEBHOOK_URL="https://<YOUR_DOMAIN>/api/telegram/webhook" \
TELEGRAM_WEBHOOK_SECRET="replace-me" \
TELEGRAM_BOT_TOKEN="replace-me" \
PORT=3000 \
npm run start
```

For deployment behind a public URL:

1. Provision a host that can run Node 20+ and keep local JSON files on persistent disk.
2. Run `npm install`.
3. Run `npm run sync:markets` on deploy, then on a schedule.
4. Start `npm run start` under a process manager or container runtime.
5. Put the service behind HTTPS.
6. Keep `REVIEWER_AUTH_TOKEN` out of source control.

## Deploy And Test Telegram

The current integration point is the webhook receiver at `POST /api/telegram/webhook`.

1. Create a bot with BotFather and get the bot token.
2. Deploy the API to a public HTTPS URL.
3. Set these env vars on the API before startup:

```bash
TELEGRAM_BOT_TOKEN="<TELEGRAM_BOT_TOKEN>"
TELEGRAM_WEBHOOK_URL="https://<YOUR_DOMAIN>/api/telegram/webhook"
TELEGRAM_WEBHOOK_SECRET="<TELEGRAM_WEBHOOK_SECRET>"
```

The server will register the webhook with Telegram automatically on boot.

4. In Telegram, send your bot a message in this format:

```text
/clarify gm_btc_above_100k Should auction prints count?
```

5. Confirm the request was stored:

```bash
curl "https://<YOUR_DOMAIN>/api/telegram/requests?chat_id=<CHAT_ID>&user_id=<USER_ID>"
```

6. Simulate downstream status updates:

```bash
curl -X POST "https://<YOUR_DOMAIN>/api/telegram/requests/<REQUEST_ID>/status" \
  -H 'content-type: application/json' \
  -d '{
    "status": "completed",
    "clarificationId": "clar_001",
    "summary": "Gemini auction and spot prints both count toward resolution."
  }'
```

Current expectation: if `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_WEBHOOK_URL` are set and the process starts cleanly, the server will register the webhook on boot. With `TELEGRAM_BOT_TOKEN` configured, inbound webhook intake and outbound status delivery should both work.

## In Progress / Missing Pieces

- The LLM integration now supports real provider calls, but it falls back to the deterministic local stub when no provider API key is configured.
- Persistence is file-backed JSON, not a production database.
- There is no deployment packaging yet for Docker, systemd, or managed platforms.
- Reviewer auth is a single shared token and still needs hardening.
