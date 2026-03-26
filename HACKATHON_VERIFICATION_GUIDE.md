# Hackathon Verification Guide

This is the remaining work before submission: run the demo exactly how judges will see it, verify the critical flows manually, and capture proof that each one works.

Do not commit from this guide. Treat it as a runbook for final QA.

## What still needs to be done

- Verify the production-style demo stack boots cleanly from `.env` and `docker-compose.demo.yml`.
- Verify the public clarification intake flow returns a valid x402 payment challenge.
- Verify at least one full paid clarification request completes end-to-end.
- Verify the reviewer desk can load both upcoming and live queues with the reviewer token.
- Verify at least one prelaunch ambiguity scan runs and its result appears in the UI.
- Verify reviewer-only API routes reject missing or bad auth.
- Verify the demo you plan to show is reproducible on a clean restart.
- Capture screenshots or terminal output for submission/demo backup.

## 1. Preflight

Run this from the repo root:

```bash
git status --short
```

Expected:

- You understand any existing local edits.
- You do not rely on untracked local hacks that are not part of the demo.

Then confirm required tools exist:

```bash
docker --version
docker compose version
node --version
npm --version
```

## 2. Fill the demo env

Start from the template if needed:

```bash
cp .env.example .env
```

If you already keep demo-specific secrets in `.env.demo`, `./scripts/deploy-demo.sh` will use that automatically when `.env` is absent.

`npm run start` (local dev) now auto-loads `.env` via dotenv. No manual sourcing required.

Edit `.env` and make sure these are real values:

- `POSTGRES_PASSWORD`
- `OPENROUTER_API_KEY` or your actual LLM provider key
- `X402_RECIPIENT_ADDRESS`
- `PUBLIC_API_BASE_URL` if you will expose the backend publicly

Recommended for hackathon verification:

- `ENABLE_PHASE2_REVIEWER_ROUTES=1`
- `REVIEWER_AUTH_TOKEN=demo-reviewer-token` or another known token
- `ENABLE_TELEGRAM_ROUTES=0`
- `ARTIFACT_PUBLICATION_PROVIDER=disabled`

Important:

- If you want the bundled demo stack, leave `DATABASE_URL` out of `.env`; `docker-compose.demo.yml` injects it for the container.
- The `.env.example` network and mint are mainnet-style defaults. If you intend to use a different x402/facilitator setup, keep all payment-side values aligned.

## 3. Boot the demo stack

Bring up the production-style demo:

```bash
./scripts/deploy-demo.sh
```

Then watch logs:

```bash
docker compose -f docker-compose.demo.yml logs -f offchain-backend
```

Pass criteria:

- Postgres becomes healthy.
- The backend starts without crashing.
- Startup does not fail on config validation.
- Market sync runs on boot.
- The script prints the reviewer token.

If startup fails, fix env issues before doing anything else.

## 4. Check health endpoints

In another terminal:

```bash
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
```

Pass criteria:

- Both return HTTP `200`.
- `/health/ready` confirms the app is actually ready, not just running.

## 5. Verify the unpaid clarification challenge

### Find a real event ID from the Postgres market cache

The stack stores all synced markets in Postgres. Query it directly while the stack is running:

```bash
# Active markets — prefer long-horizon ones; clarification is most valuable early
docker compose -f docker-compose.demo.yml exec postgres \
  psql -U gemini_pm -d gemini_pm -c \
  "SELECT market_id, payload->>'title' AS title, closes_at
   FROM market_cache
   WHERE market_stage = 'active'
   ORDER BY closes_at DESC
   LIMIT 20;"

# Upcoming markets
docker compose -f docker-compose.demo.yml exec postgres \
  psql -U gemini_pm -d gemini_pm -c \
  "SELECT market_id, payload->>'title' AS title, closes_at
   FROM market_cache
   WHERE market_stage = 'upcoming'
   ORDER BY closes_at ASC
   LIMIT 20;"
```

Prefer markets with long horizons or open-ended resolution criteria — clarification is most valuable before trading volume builds around an ambiguous interpretation.

### Suggested markets for validation

The following are real markets from the current sync that have genuine resolution ambiguity.

**Active markets**

`4020` — *"Recession this year?"*
Resolves on two consecutive quarters of negative BEA GDP — not an NBER declaration. The narrow drafting gap: the terms tie expiration to the Advance Estimate of Q4 GDP and settlement to the "official BEA value at expiration," which strongly implies advance-only, but never explicitly states that a later revision showing a positive quarter is ignored. Good test of whether the system can identify a subtle drafting gap while correctly reading the trigger as BEA-quarters-only.

```bash
curl -i -X POST http://127.0.0.1:3000/api/clarify/4020 \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "phase1_tester",
    "question": "If the BEA advance estimate shows two consecutive negative quarters but a subsequent revision turns one of those quarters positive before settlement, which figure controls resolution?"
  }'
```

`2640` — *"Will crypto market structure legislation become law?"*
Some contracts define qualifying legislation by a three-prong test (regulatory framework, agency delineation, and non-stablecoin-only scope). Ambiguity: a bill that originated as stablecoin-only legislation but was amended to include broader digital asset market structure provisions may or may not satisfy the qualifying definition — the rules are flexible enough to allow a content-based match but that same flexibility requires a judgment call at settlement.

```bash
curl -i -X POST http://127.0.0.1:3000/api/clarify/2640 \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "phase1_tester",
    "question": "Would a bill that began as stablecoin-only legislation but was amended to include broader digital asset market structure provisions satisfy the qualifying definition for this market?"
  }'
```

`4022` — *"NASA lands on the moon?"*
The market title says "NASA lands" but the resolution rules specify a "manned NASA mission." This is a good test of the full-terms fetch: the system should read the linked resolution criteria, surface the crewed-only requirement, and explain why a NASA-contracted CLPS robotic lander would not qualify. The value here is that the answer *is* in the terms — it just requires fetching and parsing them correctly.

```bash
curl -i -X POST http://127.0.0.1:3000/api/clarify/4022 \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "phase1_tester",
    "question": "Does a robotic lander delivered under a NASA CLPS contract satisfy the resolution condition, or is a crewed NASA Artemis surface touchdown strictly required?"
  }'
```

### Trigger the 402 challenge

Use any of the suggested markets above, or substitute your own `<EVENT_ID>`:

```bash
curl -i -X POST http://127.0.0.1:3000/api/clarify/<EVENT_ID> \
  -H 'content-type: application/json' \
  -d '{
    "requesterId": "phase1_tester",
    "question": "What source and timing rules control final resolution here?"
  }'
```

Pass criteria:

- Response status is `402`.
- Response includes `paymentRequirements`.
- The response clearly states payment is required before creating the clarification.

This is the minimum proof that the public intake is wired correctly.

## 6. Verify one full paid clarification end-to-end

Use the helper script already in the repo:

```bash
API_BASE_URL=http://127.0.0.1:3000 \
./scripts/request-clarification.sh <EVENT_ID> "What exact conditions settle this market?"
```

The script expects a usable Solana keypair at `~/.config/solana/id.json` and will:

- request the 402 challenge
- create the x402 payment payload
- retry with the payment proof
- wait for the clarification to complete
- install a temporary x402 client toolchain under `/tmp/x402-client-test` unless `X402_CLIENT_DIR` is already set

Pass criteria:

- The script returns JSON with a `clarificationId`.
- Final status becomes `completed`.
- `llmOutput` is present.
- No facilitator verification error appears.

If this fails, submission is not ready for a live end-to-end payment demo, even if the unpaid challenge works.

## 7. Verify the public console manually

Start the frontend in a separate terminal:

```bash
cd apps/public-console
npm install
npm run dev
```

Open the printed local URL.

Manual steps:

1. Open settings and set backend API base URL to `http://127.0.0.1:3000`.
2. Submit a clarification request with the same `<EVENT_ID>` used above.
3. Confirm the UI shows `Payment required`.
4. Confirm at least one payment requirement card is rendered.
5. Confirm the built-in reviewer desk surface opens and can be configured from the same app.

Pass criteria:

- The public console connects to the backend.
- The intake form does not crash.
- The response state in the UI matches the backend response.

## 8. Verify the reviewer desk manually

In `/reviewer`:

1. Open settings.
2. Set backend API base URL to `http://127.0.0.1:3000`.
3. Set reviewer auth token to the value printed by `./scripts/deploy-demo.sh`.
4. Save. The desk stores these values in browser session storage, so recheck them after a tab reload or new session.

Then verify both surfaces.

### Upcoming review surface

1. Stay on `Upcoming`.
2. Confirm the queue loads.
3. Pick an event and click `Inspect`.
4. Click `Run scan`.
5. Confirm the detail panel updates with score, recommendation, and reason.
6. Optionally run `Scan all upcoming` once.

Pass criteria:

- Queue loads with no auth error.
- Inspect works.
- Running a scan creates or refreshes a stored result.
- The UI remains usable after refresh.

### Live clarifications surface

1. Switch to `Live`.
2. Confirm the queue loads.
3. Find the clarification you created in step 6.
4. Open detail.
5. Verify all major panels render:
   - source market text
   - LLM interpretation
   - funding and review state
   - artifact preview or a clear “not available” message

Pass criteria:

- The clarification appears in the live queue.
- Detail view shows the completed output.
- No broken artifact/detail requests occur.

## 9. Verify reviewer API auth failures

Run one request without a token:

```bash
curl -i http://127.0.0.1:3000/api/reviewer/prelaunch/queue
```

Run one request with a bad token:

```bash
curl -i http://127.0.0.1:3000/api/reviewer/prelaunch/queue \
  -H 'x-reviewer-token: wrong-token'
```

Pass criteria:

- Both are rejected.
- Reviewer data is not exposed anonymously.

## 10. Verify reviewer detail endpoints directly

After you have a real `clarificationId`, confirm the raw reviewer APIs also work:

```bash
curl http://127.0.0.1:3000/api/reviewer/clarifications/<CLARIFICATION_ID> \
  -H 'x-reviewer-token: demo-reviewer-token'
```

```bash
curl http://127.0.0.1:3000/api/reviewer/clarifications/<CLARIFICATION_ID>/audit \
  -H 'x-reviewer-token: demo-reviewer-token'
```

Pass criteria:

- Detail endpoint returns the clarification dossier.
- Audit endpoint returns timeline-style reviewer/audit data.

This is useful demo backup if the UI has an issue during judging.

## 11. Optional finalization flow check

If you want to prove the off-chain reviewer workflow is fully wired, run:

```bash
curl -X POST http://127.0.0.1:3000/api/reviewer/clarifications/<CLARIFICATION_ID>/awaiting-panel-vote \
  -H 'content-type: application/json' \
  -H 'x-reviewer-token: demo-reviewer-token' \
  -d '{
    "reviewerId": "hackathon-reviewer"
  }'
```

```bash
curl -X POST http://127.0.0.1:3000/api/reviewer/clarifications/<CLARIFICATION_ID>/finalize \
  -H 'content-type: application/json' \
  -H 'x-reviewer-token: demo-reviewer-token' \
  -d '{
    "reviewerId": "hackathon-reviewer",
    "finalEditedText": "Final reviewer-approved wording goes here.",
    "finalNote": "Reason for final wording."
  }'
```

Pass criteria:

- Awaiting-panel-vote succeeds only after completion.
- Finalize succeeds and persists final reviewer output.

## 12. Rehearse the exact judging flow

Do one clean demo rehearsal from scratch:

1. Restart the stack.
2. Confirm health.
3. Open the public console.
4. Trigger a clarification request.
5. Switch into the reviewer desk surface.
6. Show upcoming review and run one scan.
7. Show the live clarification detail for the request created earlier.

If any step is slow or flaky, note the workaround now rather than during judging.

## 13. Capture evidence before submission

Save these artifacts locally:

- screenshot of healthy backend logs after startup
- screenshot of `/health/ready`
- screenshot of public console showing `Payment required`
- terminal output from `scripts/request-clarification.sh`
- screenshot of reviewer upcoming scan result
- screenshot of reviewer live clarification detail

If submission asks for links or demo notes, include the exact commands used.

## 14. Go / no-go checklist

You are ready to submit only if all of these are true:

- Demo stack boots with `./scripts/deploy-demo.sh`.
- Health endpoints return `200`.
- Public intake returns a valid x402 challenge.
- One paid clarification completes end-to-end.
- Reviewer desk loads with the token.
- At least one prelaunch scan succeeds.
- Live clarification detail is visible in the reviewer desk.
- Reviewer endpoints reject unauthenticated access.
- You have screenshots or logs proving the above.

If any one of those is false, that item is what remains before submission.
