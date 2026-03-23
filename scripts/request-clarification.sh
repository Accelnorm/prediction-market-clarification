#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CLIENT_DIR="${X402_CLIENT_DIR:-/tmp/x402-client-test}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3000}"
FACILITATOR_URL="${X402_FACILITATOR_URL:-https://x402.org/facilitator}"
WAIT_TIMEOUT_MS="${WAIT_TIMEOUT_MS:-15000}"

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <event-id> <question>" >&2
  echo "Example: $0 131 'Should trades during a Gemini maintenance window count?'" >&2
  exit 1
fi

EVENT_ID="$1"
shift
QUESTION="$*"

mkdir -p "$CLIENT_DIR"

if [ ! -f "$CLIENT_DIR/package.json" ]; then
  (
    cd "$CLIENT_DIR"
    npm init -y >/dev/null 2>&1
  )
fi

if [ ! -d "$CLIENT_DIR/node_modules/@x402" ] || [ ! -d "$CLIENT_DIR/node_modules/@solana/kit" ]; then
  (
    cd "$CLIENT_DIR"
    npm install @x402/fetch @x402/core @x402/svm @solana/kit >/dev/null
  )
fi

NODE_PATH="$CLIENT_DIR/node_modules" \
EVENT_ID="$EVENT_ID" \
QUESTION="$QUESTION" \
API_BASE_URL="$API_BASE_URL" \
FACILITATOR_URL="$FACILITATOR_URL" \
WAIT_TIMEOUT_MS="$WAIT_TIMEOUT_MS" \
node <<'EOF'
const fs = require("fs");
const { x402Client, x402HTTPClient } = require("@x402/fetch");
const { ExactSvmScheme } = require("@x402/svm");
const { HTTPFacilitatorClient } = require("@x402/core/http");
const { createKeyPairSignerFromBytes } = require("@solana/kit");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const baseUrl = process.env.API_BASE_URL;
  const eventId = process.env.EVENT_ID;
  const question = process.env.QUESTION;
  const facilitatorUrl = process.env.FACILITATOR_URL;
  const waitTimeoutMs = Number.parseInt(process.env.WAIT_TIMEOUT_MS ?? "15000", 10);

  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))
  );
  const signer = await createKeyPairSignerFromBytes(secret);

  const supported = await new HTTPFacilitatorClient({ url: facilitatorUrl }).getSupported();
  const feePayer = supported.signers?.["solana:*"]?.[0] || supported.signers?.solana?.[0];

  if (!feePayer) {
    throw new Error("No Solana fee payer advertised by facilitator.");
  }

  const initial = await fetch(`${baseUrl}/api/clarify/${encodeURIComponent(eventId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requesterId: signer.address,
      question
    })
  });
  const initialBody = await initial.json();

  if (initial.status !== 402) {
    throw new Error(`Expected 402 payment challenge, got ${initial.status}: ${JSON.stringify(initialBody)}`);
  }

  const client = x402Client.fromConfig({
    schemes: [{ network: "solana:*", client: new ExactSvmScheme(signer) }]
  });
  const httpClient = new x402HTTPClient(client);
  const requirement = {
    ...initialBody.paymentRequirements[0],
    feePayer,
    extra: {
      ...(initialBody.paymentRequirements[0].extra || {}),
      feePayer
    }
  };
  const paymentPayload = await client.createPaymentPayload({
    x402Version: 2,
    accepts: [requirement],
    resource: requirement.resource,
    extensions: {}
  });

  const paid = await fetch(
    `${baseUrl}/api/clarify/${encodeURIComponent(eventId)}?wait=true&timeoutMs=${encodeURIComponent(String(waitTimeoutMs))}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...httpClient.encodePaymentSignatureHeader(paymentPayload)
      },
      body: JSON.stringify({
        requesterId: signer.address,
        question
      })
    }
  );
  const paidBody = await paid.json();

  if (![200, 202].includes(paid.status)) {
    throw new Error(`Paid request failed ${paid.status}: ${JSON.stringify(paidBody)}`);
  }

  if (paid.status === 200 && paidBody?.clarification?.llmOutput) {
    console.log(JSON.stringify(paidBody, null, 2));
    return;
  }

  const clarificationId = paidBody.clarificationId ?? paidBody?.clarification?.clarificationId;

  if (!clarificationId) {
    throw new Error(`Missing clarificationId in paid response: ${JSON.stringify(paidBody)}`);
  }

  let detail = null;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/clarifications/${encodeURIComponent(clarificationId)}`);
    detail = await response.json();

    if (detail?.clarification?.status === "completed" && detail?.clarification?.llmOutput) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }

    if (detail?.clarification?.status === "failed") {
      throw new Error(`Clarification failed: ${JSON.stringify(detail)}`);
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for completed clarification: ${JSON.stringify(detail)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
EOF
