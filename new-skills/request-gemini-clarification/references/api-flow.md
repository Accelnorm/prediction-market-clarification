# Gemini Clarification API Flow

## Use This Reference

Load this file when an agent needs the exact request flow, endpoint behavior, or source pointers for Gemini market clarifications.

## Preconditions

- The backend must know the market as an active or upcoming synced event.
- `POST /api/clarify/:eventId` rejects unknown event ids with `404 UNSUPPORTED_EVENT_ID`.
- The route parameter is named `eventId` in the live backend and tests, even if some repo docs still say `marketId`.
- The JSON body must include a non-empty `question`. The backend trims whitespace and enforces a 500-character maximum.

Relevant source files:

- [README.md](/home/user/gemini-pm/README.md)
- [server.ts](/home/user/gemini-pm/offchain-backend/src/server.ts)
- [x402-paid-clarification.ts](/home/user/gemini-pm/offchain-backend/src/x402-paid-clarification.ts)
- [request-clarification.sh](/home/user/gemini-pm/scripts/request-clarification.sh)

## Request Flow

1. Create an unpaid request to obtain the x402 challenge:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

2. Retry the same request with the x402 proof in `PAYMENT-SIGNATURE`:

```bash
curl -X POST http://127.0.0.1:3000/api/clarify/gm_btc_above_100k \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payment-payload>' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

3. If a fast inline response is useful, add `wait=true` and a timeout:

```bash
curl -X POST 'http://127.0.0.1:3000/api/clarify/gm_btc_above_100k?wait=true&timeoutMs=10000' \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payment-payload>' \
  -d '{
    "requesterId": "wallet_123",
    "question": "Should auction prints count?"
  }'
```

4. Poll by clarification id:

```bash
curl http://127.0.0.1:3000/api/clarifications/<CLARIFICATION_ID>
```

## Behavioral Notes

- Missing payment proof returns `402` and a payment challenge payload.
- A duplicate paid retry with the same verified payment proof returns the existing clarification instead of creating a new one.
- The backend rate-limits clarification creation and may return `429` with `retry-after`.
- Clarification requests enter the asynchronous pipeline with initial status `queued`.
- The backend returns a `clarificationId` on successful paid creation; use that id for public polling.
