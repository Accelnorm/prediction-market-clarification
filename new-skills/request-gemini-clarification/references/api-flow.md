# Gemini Clarification API Flow

## Use This Reference

Load this file when an agent needs the exact request flow or endpoint behavior for Gemini market clarifications against the live demo backend.

## Preconditions

- The backend must know the market as an active or upcoming synced event.
- `POST /api/clarify/:eventId` rejects unknown event ids with `404 UNSUPPORTED_EVENT_ID`.
- The route parameter is named `eventId` in the live backend and tests, even if some repo docs still say `marketId`.
- The JSON body must include a non-empty `question`. The backend trims whitespace and enforces a 500-character maximum.

## Request Flow

Base URL:

- `https://prediction-market-clarification-api.onrender.com`

1. Create an unpaid request to obtain the x402 challenge:

```bash
curl -X POST https://prediction-market-clarification-api.onrender.com/api/clarify/2640 \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "wallet_123",
    "question": "If Congress passes a broader digital-asset bill that includes market-structure rules but also substantial stablecoin or other crypto provisions, what makes that bill qualify as crypto market structure legislation for this market?"
  }'
```

2. Retry the same request with the x402 proof in `PAYMENT-SIGNATURE`:

```bash
curl -X POST https://prediction-market-clarification-api.onrender.com/api/clarify/2640 \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payment-payload>' \
  -d '{
    "requesterId": "wallet_123",
    "question": "If Congress passes a broader digital-asset bill that includes market-structure rules but also substantial stablecoin or other crypto provisions, what makes that bill qualify as crypto market structure legislation for this market?"
  }'
```

3. If a fast inline response is useful, add `wait=true` and a timeout:

```bash
curl -X POST 'https://prediction-market-clarification-api.onrender.com/api/clarify/2640?wait=true&timeoutMs=10000' \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <base64-encoded-x402-payment-payload>' \
  -d '{
    "requesterId": "wallet_123",
    "question": "If Congress passes a broader digital-asset bill that includes market-structure rules but also substantial stablecoin or other crypto provisions, what makes that bill qualify as crypto market structure legislation for this market?"
  }'
```

4. Poll by clarification id:

```bash
curl https://prediction-market-clarification-api.onrender.com/api/clarifications/<CLARIFICATION_ID>
```

## Behavioral Notes

- Missing payment proof returns `402` and a payment challenge payload.
- A duplicate paid retry with the same verified payment proof returns the existing clarification instead of creating a new one.
- The backend rate-limits clarification creation and may return `429` with `retry-after`.
- Clarification requests enter the asynchronous pipeline with initial status `queued`.
- The backend returns a `clarificationId` on successful paid creation; use that id for public polling.
