import test from "node:test";
import assert from "node:assert/strict";

import {
  isProductionRuntime,
  resolvePhase2RoutesEnabled,
  resolveTelegramEnabled,
  validateProductionRuntimeConfig
} from "../src/runtime-config.js";

const VALID_X402_CONFIG = {
  payaiApiKeyId: "payai-key-id",
  payaiApiKeySecret: "payai_sk_test-secret",
  recipientAddress: "7Y9Yk3Lx4n1u4V7S1k4U6yWw2o1j9mA8Y7h6R5q4P3d2",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
};

test("production runtime detection uses APP_ENV or NODE_ENV", () => {
  assert.equal(isProductionRuntime({ APP_ENV: "production" }), true);
  assert.equal(isProductionRuntime({ NODE_ENV: "production" }), true);
  assert.equal(isProductionRuntime({ NODE_ENV: "test" }), false);
});

test("feature flags resolve from explicit env toggles", () => {
  assert.equal(resolvePhase2RoutesEnabled({ ENABLE_PHASE2_REVIEWER_ROUTES: "1" }), true);
  assert.equal(resolvePhase2RoutesEnabled({ ENABLE_PHASE2_REVIEWER_ROUTES: "0" }), false);
  assert.equal(resolveTelegramEnabled({ ENABLE_TELEGRAM_ROUTES: "true" }), true);
  assert.equal(resolveTelegramEnabled({ ENABLE_TELEGRAM_ROUTES: "" }), false);
});

test("production validation rejects missing critical configuration", () => {
  assert.throws(
    () =>
      validateProductionRuntimeConfig({
        env: { NODE_ENV: "production" },
        llmRuntime: { apiKey: null },
        x402PaymentConfig: {
          facilitatorAuthToken: null,
          payaiApiKeyId: null,
          payaiApiKeySecret: null,
          recipientAddress: "11111111111111111111111111111111",
          network: "",
          mintAddress: ""
        },
        telegramEnabled: false,
        hasDatabase: false
      }),
    /DATABASE_URL is required in production/
  );
});

test("production validation accepts unauthenticated facilitator access", () => {
  assert.doesNotThrow(() =>
    validateProductionRuntimeConfig({
      env: { NODE_ENV: "production" },
      llmRuntime: { apiKey: "llm-key" },
      x402PaymentConfig: {
        facilitatorAuthToken: null,
        payaiApiKeyId: null,
        payaiApiKeySecret: null,
        recipientAddress: VALID_X402_CONFIG.recipientAddress,
        network: VALID_X402_CONFIG.network,
        mintAddress: VALID_X402_CONFIG.mintAddress
      },
      telegramEnabled: false,
      hasDatabase: true
    })
  );
});

test("production validation accepts legacy bearer-token auth while migrating", () => {
  assert.doesNotThrow(() =>
    validateProductionRuntimeConfig({
      env: { NODE_ENV: "production" },
      llmRuntime: { apiKey: "llm-key" },
      x402PaymentConfig: {
        facilitatorAuthToken: "legacy-token",
        payaiApiKeyId: null,
        payaiApiKeySecret: null,
        recipientAddress: VALID_X402_CONFIG.recipientAddress,
        network: VALID_X402_CONFIG.network,
        mintAddress: VALID_X402_CONFIG.mintAddress
      },
      telegramEnabled: false,
      hasDatabase: true
    })
  );
});

test("production validation accepts complete phase 1 configuration", () => {
  assert.doesNotThrow(() =>
    validateProductionRuntimeConfig({
      env: {
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "bot",
        TELEGRAM_WEBHOOK_URL: "https://example.com/api/telegram/webhook",
        TELEGRAM_WEBHOOK_SECRET: "secret"
      },
      llmRuntime: { apiKey: "llm-key" },
      x402PaymentConfig: VALID_X402_CONFIG,
      artifactPublicationConfig: {
        provider: "disabled",
        enabled: false
      },
      telegramEnabled: true,
      hasDatabase: true
    })
  );
});

test("production validation rejects missing IPFS API configuration when IPFS publication is enabled", () => {
  assert.throws(
    () =>
      validateProductionRuntimeConfig({
        env: { NODE_ENV: "production" },
        llmRuntime: { apiKey: "llm-key" },
        x402PaymentConfig: VALID_X402_CONFIG,
        artifactPublicationConfig: {
          provider: "ipfs",
          enabled: true,
          ipfsApiUrl: null
        },
        telegramEnabled: false,
        hasDatabase: true
      }),
    /IPFS_API_URL is required/
  );
});

test("production validation requires complete telegram config when telegram is enabled", () => {
  assert.throws(
    () =>
      validateProductionRuntimeConfig({
        env: { NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "bot" },
        llmRuntime: { apiKey: "llm-key" },
        x402PaymentConfig: VALID_X402_CONFIG,
        telegramEnabled: true,
        hasDatabase: true
      }),
    /TELEGRAM_WEBHOOK_URL is required/
  );
});
