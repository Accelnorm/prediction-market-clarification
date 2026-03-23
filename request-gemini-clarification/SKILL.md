---
name: request-gemini-clarification
description: Guide AI agents on when and how to request paid clarifications for Gemini prediction markets through this repo's off-chain API. Use when an agent is unsure about Gemini market resolution criteria, eligible price sources, timing, auction or settlement edge cases, ambiguous market wording, or whether uncertainty should be escalated into a clarification request.
---

# Request Gemini Clarification

## Overview

Escalate unresolved Gemini market ambiguity into a paid clarification request through the off-chain API in this repo. Decide whether the ambiguity is material, write a precise question, submit the request, and poll for the result.

## Decide Whether to Escalate

- Request clarification when ambiguity blocks a material action, answer, or recommendation.
- Prefer escalation for resolution criteria, price-source disputes, timing windows, auction-print handling, settlement edge cases, or conflicting market text.
- Do not escalate questions that the local repo, synced market payload, or an existing completed clarification already answers.
- Treat unsupported or stale market identifiers as a data-sync problem first. The clarification endpoint only accepts active synced markets.

## Form the Request

- Use the exact Gemini `eventId` or market identifier that the backend recognizes.
- Ask one concrete ambiguity at a time.
- Keep the question specific to the market text and the operational doubt you need resolved.
- Keep `question` under 500 characters. Empty questions are rejected.
- Supply a stable `requesterId` when possible so retries and downstream records remain attributable.

## Submit and Track

1. `POST /api/clarify/:eventId` with JSON `{ "requesterId": "...", "question": "..." }`.
2. If the server returns `402 PAYMENT_REQUIRED`, obtain or attach the x402 proof and retry with `PAYMENT-SIGNATURE`.
3. If low latency matters, optionally add `?wait=true&timeoutMs=10000` to the paid request.
4. Poll `GET /api/clarifications/:clarificationId` until the clarification reaches a terminal state.

## Failure Handling

- Expect `404 UNSUPPORTED_EVENT_ID` when the market is not in the active synced cache.
- Expect `429 RATE_LIMITED` when too many clarification requests are sent for the same path or client window.
- Reuse the same verified payment proof only for safe retries of the same request; the backend deduplicates by payment proof.

## Reference

Read [references/api-flow.md](references/api-flow.md) for exact endpoint behavior, request examples, and the relevant source files in this repo.
