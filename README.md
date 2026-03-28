# The Prediction Market Oracle's Wake-Up Call

**A pay-per-clarification API for Gemini prediction markets — resolving contract ambiguity before it becomes a dispute.**

When a prediction market's resolution criteria are unclear, traders lose trust and operators face costly settlement disputes. This project proposes a new primitive to that stack: a paid clarification endpoint. A trader or AI agent sends a question about a Gemini market, makes a $1 micropayment via the [x402 protocol](https://www.x402.org) on Solana, and receives an LLM-generated authoritative clarification.

The clarification follows a structured AI skill that reviews the operative clause, scores ambiguity, writes a binding clarification note, and proposes tighter market text if needed — not a freeform LLM opinion.

## Live demo

- Public console: https://prediction-market-clarification-console.onrender.com
- Reviewer route: https://prediction-market-clarification-console.onrender.com/reviewer
- Backend API: https://prediction-market-clarification-api.onrender.com

---

## Why this matters for prediction market operators

Ambiguous resolution criteria are one of the highest sources of user complaints and reputational risk in prediction markets. This system lets operators:

- **Offload clarification requests** to an automated, paid service
- **Build a precedent library** — every clarification becomes a reusable artifact
- **Integrate AI-powered pre-launch review** to catch ambiguity before markets go live
- **Monetize the clarification channel** — the x402 payment gate means spam is economically infeasible and genuine requests not only cover the LLM cost but also generate revenue

The system is API-first. In this prototype, it tests the concept based on data from the Gemini Prediction Markets API and exposes clean REST endpoints for clarification intake, status polling, and reviewer workflows. Such endpoints could potentially be added to the Gemini API.

---

## Custom AI skills

This repo ships three agent skills for AI-assisted workflows:

- **`$request-gemini-clarification`** — guides an AI agent on when and how to escalate market uncertainty into a paid clarification request
- **`$issue-clarification-response`** — guides the clarification LLM on deterministic reasoning, tighter rewrites, and operator notes
- **`$review-upcoming-market`** — guides a reviewer LLM on detecting ambiguity, bad sources, time-boundary problems, and missing conditional branches in upcoming markets

Skills live under [`new-skills/`](new-skills/).

---

## How it works

```
Trader / AI agent
       │
       ▼
POST /api/clarify/:eventId
       │
       ├─► 402 Payment Required (x402 challenge, $1 USDC on Solana)
       │
       ├─► Client signs & retries with payment proof
       │
       ├─► Payment verified via x402 facilitator
       │
       └─► LLM processes question against market contract text
               │
               └─► Clarification stored + returned (async or sync)
```

The backend pulls live market data from the Gemini Prediction Markets API, processes clarification jobs in a durable background queue with crash recovery, and exposes a public status endpoint for polling.

A reviewer desk lets authorized operators scan upcoming markets for ambiguity before launch. Markets that share the same standard terms can be put on a persistent skip-scan list so the prelaunch queue does not keep resurfacing duplicate ambiguity reviews.

---

## Run locally

### Prerequisites

- Docker and Docker Compose
- Node.js and npm
- A real `OPENROUTER_API_KEY`
- A Solana wallet address for `X402_RECIPIENT_ADDRESS`
- A local Solana keypair at `~/.config/solana/id.json` if you want to run the full paid clarification flow with the helper script

### 1. Configure env

You only need three values to get the stack up:

| Variable | What it is |
|---|---|
| `OPENROUTER_API_KEY` | Any LLM via [OpenRouter](https://openrouter.ai) |
| `X402_RECIPIENT_ADDRESS` | Your Solana wallet address (USDC) |
| `POSTGRES_PASSWORD` | Any password for the bundled DB |

```bash
cp .env.example .env
# Edit .env — fill in the three values above
```

The script starts a Docker Compose stack (backend + Postgres), syncs Gemini markets on boot, and prints your reviewer auth token.

`npm run start` in the backend auto-loads `.env` via dotenv, so no manual `source` step is needed.

### 2. Start the demo stack

```bash
./scripts/deploy-demo.sh
docker compose -f docker-compose.demo.yml logs -f offchain-backend
```

You should see Postgres become healthy, the backend start cleanly, and the initial Gemini market sync complete.

### 3. Start the console locally

```bash
cd apps/public-console
npm install
npm run dev
```

Open the local Vite URL, set the backend API base URL to `http://127.0.0.1:3000`, and use the reviewer token printed by `./scripts/deploy-demo.sh` if you want to use the reviewer desk locally.

### 4. Verify the backend is ready

```bash
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
```

Both should return HTTP `200`.

### 5. Trigger an unpaid clarification challenge

Use a real Gemini event ID. One example:

```bash
curl -i -X POST http://127.0.0.1:3000/api/clarify/gm_us_stablecoin_bill \
  -H 'content-type: application/json' \
  -d '{"requesterId": "wallet_abc", "question": "If Congress passes a broader digital-asset package that includes stablecoin provisions alongside market-structure rules, does this market resolve Yes, or does resolution require standalone stablecoin-only legislation?"}'
```

This should return `402 Payment Required` with `paymentRequirements`.

### 6. Run one full paid clarification locally

```bash
API_BASE_URL=http://127.0.0.1:3000 \
./scripts/request-clarification.sh gm_us_stablecoin_bill "If Congress passes a broader digital-asset package that includes stablecoin provisions alongside market-structure rules, does this market resolve Yes, or does resolution require standalone stablecoin-only legislation?"
```

The helper script requests the challenge, signs the x402 payment using your local Solana keypair, retries with proof, and waits for the clarification to complete.

### 7. Use the reviewer route locally

Open `/reviewer` in the local console, set:

- Backend API base URL: `http://127.0.0.1:3000`
- Reviewer auth token: the token printed by `./scripts/deploy-demo.sh`

With reviewer routes enabled, you can load the live queue, upcoming queue, run scans, and manage shared-terms skip-scan entries.

### Full `.env.example`

```bash
# LLM (required)
OPENROUTER_API_KEY=replace-me

# x402 payments (required: your recipient wallet)
X402_RECIPIENT_ADDRESS=replace-with-your-solana-usdc-wallet

# Postgres (bundled in Docker — just set a password)
POSTGRES_PASSWORD=replace-me-with-a-strong-password

# ── Everything below has sensible defaults ──

PORT=3000
LLM_PROVIDER=openrouter
LLM_MODEL=openrouter/auto
X402_NETWORK=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
X402_MINT_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
X402_FACILITATOR_URL=https://x402.org/facilitator
ENABLE_PHASE2_REVIEWER_ROUTES=1
REVIEWER_AUTH_TOKEN=demo-reviewer-token
ARTIFACT_PUBLICATION_PROVIDER=disabled
```

---

## API walkthrough

**Step 1 — Request the payment challenge:**

```bash
curl -X POST http://localhost:3000/api/clarify/gm_us_stablecoin_bill \
  -H 'content-type: application/json' \
  -d '{"requesterId": "wallet_abc", "question": "If Congress passes a broader digital-asset package that includes stablecoin provisions alongside market-structure rules, does this market resolve Yes, or does resolution require standalone stablecoin-only legislation?"}'
```

Returns `402 Payment Required` with x402 payment terms.

**Step 2 — Retry with payment proof:**

```bash
curl -X POST http://localhost:3000/api/clarify/gm_us_stablecoin_bill \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payload>' \
  -d '{"requesterId": "wallet_abc", "question": "If Congress passes a broader digital-asset package that includes stablecoin provisions alongside market-structure rules, does this market resolve Yes, or does resolution require standalone stablecoin-only legislation?"}'
```

Returns a `clarificationId`. Use `?wait=true&timeoutMs=10000` for a synchronous response.

**Step 3 — Poll or fetch the result:**

```bash
curl http://localhost:3000/api/clarifications/<CLARIFICATION_ID>
```

The same pattern applies to any Gemini market with ambiguous resolution criteria. A recession market, for instance, raises a different but equally real dispute: "If the NBER formally declares a recession before the deadline but no two consecutive quarters of negative GDP appear in the BEA advance estimates, does this market resolve Yes or No?" — a question that hinges on which of two materially different standards the resolver applies.

Another public-demo example is the Kalshi Iran leader lawsuit over a post-hoc "death carveout." The public console links to that case because it is exactly the dispute class this product is meant to prevent: a market with opaque resolution criteria or after-the-fact rule changes that create settlement ambiguity after trading has already started.

---

## Gemini API endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /v1/prediction-markets/events?status=active` | Full active market sync |
| `GET /v1/prediction-markets/events/upcoming` | Upcoming markets for pre-launch review |
| `GET /v1/prediction-markets/events/newly-listed` | Incremental ingest between full syncs |
| `GET /v1/prediction-markets/events/{ticker}` | Single-market rehydration |
| `GET /v1/prediction-markets/categories` | Category catalog for validation |
| `GET /v1/trades/{instrumentSymbol}` | Trade activity for dynamic finality windows |

No order-management endpoints are used. This is clarification infrastructure, not a trading tool.

---

## Tests

```bash
cd offchain-backend && npm install && npm test
```

Covers: market sync normalization, clarification creation and deduplication, payment verification flow, health endpoints, route gating, reviewer routes, Telegram webhook parsing, and production config validation.

---

## How this project relates to challenges in the Penn Blockchain Hackathon 2026

### Gemini Prediction Markets API

This project does something different than visualizing data or trading: it uses the API as the foundation for a *resolution layer* that sits between a market and its participants. Six endpoints are in active use — active market sync, upcoming market sync, incremental ingest, single-market lookup, category catalog, and trade history for dynamic finality windows. Market data flows into both the clarification engine and the pre-launch reviewer desk, so the integration is load-bearing, not decorative.

The pay-per-clarification model creates incentives that a dashboard never could. Traders have a formal recourse channel. Operators are rewarded for maintaining clear contracts. And because clarifications are stored against specific market IDs, every ruling becomes an auditable artifact tied to the Gemini market data that generated it.

The backend is built to production standards: durable job queue with crash recovery, idempotent incremental ingest by `marketId`, configurable static/dynamic finality windows, rate limiting, request ID logging, health endpoints, and a full test suite. There are three surfaces — a REST API, a public status endpoint, and a browser-based reviewer desk — each aimed at a different user: developer, trader, and operator. One-command Docker Compose deploy, no manual schema migration.

---

### x402 Agentic Payments on Solana

x402 is frequently demoed with a simple paywall in front of a file or webpage. Rather than shipping a separate x402 side project, this repo embeds x402 directly into the clarification flow: payment is part of the actual prediction-market product. You pay for a structured expert opinion, not a static asset. That distinction matters because it creates a real use case for agentic clarification — an AI agent with a funded Solana wallet can autonomously identify an ambiguous market contract, pay for a clarification, and act on the result, with no API keys, no accounts, and no human in the loop.

The payment gate does double duty. It makes spam economically infeasible. And it creates skin-in-the-game for requesters — a question worth asking is worth $1.

The x402 implementation is complete end-to-end: 402 challenge issued, payment signed on Solana, facilitator verifies settlement, clarification job runs. The backend handles the full 402→sign→retry flow with proper header parsing, payment proof storage, and idempotent deduplication so a client retrying after a timeout cannot be charged twice. Supports both `exact` and `unauthenticated` scheme variants. The x402 handshake is invisible to users of the public console; for developers and agents, any x402-compatible client wallet works without custom integration.

Prediction market resolution disputes are a recurring cost with no clean solution today. This system is directly deployable by any operator, and the x402 payment model makes it self-sustaining — LLM costs are covered by clarification fees.

---

## Feature ideas or in progress

**Precedent-based consistency:** Idea — when a new clarification arrives, the system checks for prior clarifications on substantially similar markets and follows that precedent rather than reasoning from scratch.

**IPFS publication:** Idea — Set `ARTIFACT_PUBLICATION_PROVIDER=ipfs` with `IPFS_API_URL` and `IPFS_AUTH_TOKEN` to publish clarification artifacts to IPFS for permanent public audit trails. IPFS CID can then be published on-chain.

**Telegram intake:** Partly developed — Set `ENABLE_TELEGRAM_ROUTES=1` with a bot token and webhook URL. Telegram is a status-delivery and intake channel only — x402 payment required.

**Shared-terms skip-scan:** Implemented for prelaunch review — reviewers can mark a shared `termsLink` as global standard terms so identical upcoming markets stop generating duplicate scan work.

---

## Known Limitations

- **Need for adoption by prediction market operator.** This hackathon project is not an official Gemini feature. Unless adopted, Gemini's settlement engine will not apply clarifications automatically.
- **x402 facilitator is a single point of failure.** Verification is one HTTP call with no retry. A facilitator outage blocks all incoming clarifications, and payment events are not logged.
- **Reviewer auth and rate limiting are prototype-grade.** Plaintext bearer token, in-memory rate limiter that resets on restart.
- **No crowdfunding for human review yet.** Reviewer and funding-related routes exist in the prototype, but there is not yet a real human-review crowdfunding flow that operators or traders can actually use end-to-end.
- **Prompt and model tuning is still baseline.** What the LLM flags as defective terms or useful clarifications will sometimes miss the mark because prompt wording, evaluation heuristics, and model selection have not been tuned yet.

---
