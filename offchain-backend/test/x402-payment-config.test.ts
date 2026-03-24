// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { loadX402PaymentConfig } from "../src/x402-payment-config.js";

test("loadX402PaymentConfig defaults to PayAI facilitator and reads PayAI API keys", () => {
  const config = loadX402PaymentConfig({
    PAYAI_API_KEY_ID: "payai-key-id",
    PAYAI_API_KEY_SECRET: "payai_sk_test-secret"
  });

  assert.equal(config.facilitatorUrl, "https://facilitator.payai.network");
  assert.equal(config.payaiApiKeyId, "payai-key-id");
  assert.equal(config.payaiApiKeySecret, "payai_sk_test-secret");
  assert.equal(config.facilitatorAuthToken, null);
  assert.equal(config.verificationSource, "payai_facilitator");
});

test("loadX402PaymentConfig still accepts legacy facilitator bearer tokens", () => {
  const config = loadX402PaymentConfig({
    X402_FACILITATOR_AUTH_TOKEN: "legacy-token",
    X402_FEE_PAYER: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"
  });

  assert.equal(config.facilitatorAuthToken, "legacy-token");
  assert.equal(config.payaiApiKeyId, null);
  assert.equal(config.payaiApiKeySecret, null);
  assert.equal(config.feePayer, "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5");
});
