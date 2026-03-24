// @ts-nocheck
import { randomUUID } from "node:crypto";

import { FileArtifactRepository } from "../artifact-repository.js";
import { loadArtifactPublicationConfig } from "../artifact-publication-config.js";
import {
  createDisabledArtifactPublisher,
  createIpfsArtifactPublisher
} from "../artifact-publisher.js";
import { FileBackgroundJobRepository } from "../background-job-repository.js";
import { FileCategoryCatalogRepository } from "../category-catalog-repository.js";
import { FileClarificationRequestRepository } from "../clarification-request-repository.js";
import { loadLlmRuntime } from "../llm-runtime-config.js";
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
const llmRuntime = loadLlmRuntime(process.env);
const x402PaymentConfig = loadX402PaymentConfig();
const artifactPublicationConfig = loadArtifactPublicationConfig();
const enablePhase2Routes = resolvePhase2RoutesEnabled(process.env);
const enableTelegramRoutes = resolveTelegramEnabled(process.env);
const clarificationFinalityConfig = resolveClarificationFinalityConfig(process.env);
const storageRuntime = await createStorageRuntime();
const artifactPublisher =
  artifactPublicationConfig.provider === "ipfs"
    ? createIpfsArtifactPublisher(artifactPublicationConfig)
    : createDisabledArtifactPublisher();

validateProductionRuntimeConfig({
  env: process.env,
  llmRuntime,
  x402PaymentConfig,
  artifactPublicationConfig,
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
  artifactPublisher,
  clarificationFinalityConfig,
  llmTraceability: {
    promptTemplateVersion:
      process.env.LLM_PROMPT_TEMPLATE_VERSION ?? "issue-clarification-response-v1",
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
