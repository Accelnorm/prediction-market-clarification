import { randomUUID } from "node:crypto";

import { FileArtifactRepository } from "../artifact-repository.js";
import { FileBackgroundJobRepository } from "../background-job-repository.js";
import { FileCategoryCatalogRepository } from "../category-catalog-repository.js";
import { FileClarificationRequestRepository } from "../clarification-request-repository.js";
import { FileMarketCacheRepository } from "../market-cache-repository.js";
import {
  checkPostgresReadiness,
  createPostgresPool,
  initializePostgresSchema,
  loadPostgresRuntimeConfig,
  PostgresArtifactRepository,
  PostgresBackgroundJobRepository,
  PostgresClarificationRequestRepository,
  PostgresCategoryCatalogRepository,
  PostgresMarketCacheRepository,
  PostgresPhase1Coordinator,
  PostgresReviewerScanRepository,
  PostgresSyncStateRepository,
  PostgresTradeActivityRepository,
  PostgresVerifiedPaymentRepository
} from "../postgres-storage.js";
import { FileReviewerScanRepository } from "../reviewer-scan-repository.js";
import {
  resolveClarificationFinalityConfig,
  resolvePhase2RoutesEnabled,
  resolveTelegramEnabled,
  validateProductionRuntimeConfig
} from "../runtime-config.js";
import { FileSyncStateRepository } from "../sync-state-repository.js";
import { createServer } from "../server.js";
import { registerTelegramWebhook } from "../telegram-bot-client.js";
import { FileTradeActivityRepository } from "../trade-activity-repository.js";
import { FileVerifiedPaymentRepository } from "../verified-payment-repository.js";
import { loadX402PaymentConfig } from "../x402-payment-config.js";

function resolvePathFromEnv(name, fallback) {
  return process.env[name] ?? new URL(fallback, import.meta.url);
}

function createId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function resolveLlmRuntime() {
  const provider = process.env.LLM_PROVIDER ?? "openrouter";

  if (provider === "openrouter") {
    return {
      provider,
      apiKey: process.env.OPENROUTER_API_KEY ?? null,
      model: process.env.LLM_MODEL ?? "openrouter/auto",
      baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      appUrl: process.env.OPENROUTER_APP_URL ?? null,
      appName: process.env.OPENROUTER_APP_NAME ?? "gemini-pm"
    };
  }

  if (provider === "openai-compatible") {
    return {
      provider,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? null,
      model: process.env.LLM_MODEL ?? "gpt-4.1-mini",
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.openai.com/v1"
    };
  }

  if (provider === "anthropic-compatible") {
    return {
      provider,
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      model: process.env.LLM_MODEL ?? "claude-sonnet-4-20250514",
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      anthropicVersion: process.env.ANTHROPIC_VERSION ?? "2023-06-01"
    };
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

async function createStorageRuntime() {
  const postgresConfig = loadPostgresRuntimeConfig();

  if (postgresConfig.connectionString) {
    const pool = createPostgresPool(postgresConfig.connectionString);
    await initializePostgresSchema(pool);

    const clarificationRequestRepository = new PostgresClarificationRequestRepository(pool);
    const verifiedPaymentRepository = new PostgresVerifiedPaymentRepository(pool);
    const backgroundJobRepository = new PostgresBackgroundJobRepository(pool);

    return {
      pool,
      clarificationRequestRepository,
      artifactRepository: new PostgresArtifactRepository(pool),
      backgroundJobRepository,
      categoryCatalogRepository: new PostgresCategoryCatalogRepository(pool),
      reviewerScanRepository: new PostgresReviewerScanRepository(pool, "active"),
      syncStateRepository: new PostgresSyncStateRepository(pool),
      tradeActivityRepository: new PostgresTradeActivityRepository(pool),
      verifiedPaymentRepository,
      marketCacheRepository: new PostgresMarketCacheRepository(pool, "active"),
      upcomingMarketCacheRepository: new PostgresMarketCacheRepository(pool, "upcoming"),
      upcomingCategoryCatalogRepository: new PostgresCategoryCatalogRepository(pool),
      upcomingReviewerScanRepository: new PostgresReviewerScanRepository(pool, "upcoming"),
      phase1Coordinator: new PostgresPhase1Coordinator({
        pool,
        clarificationRequestRepository,
        verifiedPaymentRepository,
        backgroundJobRepository
      }),
      readinessCheck: () => checkPostgresReadiness(pool)
    };
  }

  const clarificationRequestsPath = resolvePathFromEnv(
    "CLARIFICATION_REQUESTS_PATH",
    "../../data/clarification-requests.json"
  );
  const artifactsPath = resolvePathFromEnv("ARTIFACTS_PATH", "../../data/artifacts.json");
  const backgroundJobsPath = resolvePathFromEnv(
    "BACKGROUND_JOBS_PATH",
    "../../data/background-jobs.json"
  );
  const marketCachePath = resolvePathFromEnv("MARKET_CACHE_PATH", "../../data/market-cache.json");
  const upcomingMarketCachePath = resolvePathFromEnv(
    "UPCOMING_MARKET_CACHE_PATH",
    "../../data/upcoming-market-cache.json"
  );
  const reviewerScansPath = resolvePathFromEnv(
    "REVIEWER_SCANS_PATH",
    "../../data/reviewer-scans.json"
  );
  const syncStatePath = resolvePathFromEnv("SYNC_STATE_PATH", "../../data/sync-state.json");
  const categoryCatalogPath = resolvePathFromEnv(
    "CATEGORY_CATALOG_PATH",
    "../../data/category-catalog.json"
  );
  const tradeActivityPath = resolvePathFromEnv(
    "TRADE_ACTIVITY_PATH",
    "../../data/trade-activity.json"
  );
  const verifiedPaymentsPath = resolvePathFromEnv(
    "VERIFIED_PAYMENTS_PATH",
    "../../data/verified-payments.json"
  );
  const upcomingReviewerScansPath = resolvePathFromEnv(
    "UPCOMING_REVIEWER_SCANS_PATH",
    "../../data/upcoming-reviewer-scans.json"
  );

  return {
    pool: null,
    clarificationRequestRepository: new FileClarificationRequestRepository(clarificationRequestsPath),
    artifactRepository: new FileArtifactRepository(artifactsPath),
    backgroundJobRepository: new FileBackgroundJobRepository(backgroundJobsPath),
    categoryCatalogRepository: new FileCategoryCatalogRepository(categoryCatalogPath),
    reviewerScanRepository: new FileReviewerScanRepository(reviewerScansPath),
    syncStateRepository: new FileSyncStateRepository(syncStatePath),
    tradeActivityRepository: new FileTradeActivityRepository(tradeActivityPath),
    verifiedPaymentRepository: new FileVerifiedPaymentRepository(verifiedPaymentsPath),
    marketCacheRepository: new FileMarketCacheRepository(marketCachePath),
    upcomingMarketCacheRepository: new FileMarketCacheRepository(upcomingMarketCachePath),
    upcomingCategoryCatalogRepository: new FileCategoryCatalogRepository(categoryCatalogPath),
    upcomingReviewerScanRepository: new FileReviewerScanRepository(upcomingReviewerScansPath),
    phase1Coordinator: null,
    readinessCheck: async () => ({
      ok: true,
      checks: {
        storage: "file"
      }
    })
  };
}

async function maybeRegisterTelegramWebhook({ enabled, logger }) {
  if (!enabled) {
    return;
  }

  const result = await registerTelegramWebhook({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
    apiBaseUrl: process.env.TELEGRAM_BOT_API_BASE_URL
  });

  logger.info(JSON.stringify({ level: "info", message: "telegram.webhook.registered", webhookUrl: result.webhookUrl }));
}

const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const llmRuntime = resolveLlmRuntime();
const x402PaymentConfig = loadX402PaymentConfig();
const enablePhase2Routes = resolvePhase2RoutesEnabled(process.env);
const enableTelegramRoutes = resolveTelegramEnabled(process.env);
const clarificationFinalityConfig = resolveClarificationFinalityConfig(process.env);
const storageRuntime = await createStorageRuntime();

validateProductionRuntimeConfig({
  env: process.env,
  llmRuntime,
  x402PaymentConfig,
  telegramEnabled: enableTelegramRoutes,
  hasDatabase: Boolean(storageRuntime.pool)
});

const server = createServer({
  ...storageRuntime,
  now: () => new Date(),
  createClarificationId: () => createId("clar"),
  createBackgroundJobId: () => createId("job"),
  reviewerAuthToken: process.env.REVIEWER_AUTH_TOKEN,
  llmRuntime: {
    ...llmRuntime,
    requireConfiguredProvider:
      process.env.APP_ENV === "production" || process.env.NODE_ENV === "production"
  },
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramBotApiBaseUrl: process.env.TELEGRAM_BOT_API_BASE_URL,
  x402PaymentConfig,
  clarificationFinalityConfig,
  llmTraceability: {
    promptTemplateVersion:
      process.env.LLM_PROMPT_TEMPLATE_VERSION ?? "reviewer-offchain-prompt-v1",
    modelId: process.env.LLM_MODEL_ID ?? llmRuntime.model,
    processingVersion: process.env.LLM_PROCESSING_VERSION ?? "offchain-llm-pipeline-v1"
  },
  enablePhase2Routes,
  enableTelegramRoutes,
  readinessCheck: storageRuntime.readinessCheck
});

await maybeRegisterTelegramWebhook({
  enabled: enableTelegramRoutes,
  logger: console
});

await new Promise((resolve) => {
  server.listen(port, host, resolve);
});

await server.resumeRecoverableBackgroundJobs();

const address = server.address();
const resolvedPort = typeof address === "object" && address !== null ? address.port : port;
console.log(JSON.stringify({ level: "info", message: "server.started", url: `http://${host}:${resolvedPort}` }));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.markShuttingDown();

    await new Promise((resolve) => {
      server.close(() => resolve());
    });

    await storageRuntime.pool?.end?.();
    process.exit(0);
  });
}
