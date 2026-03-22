import { randomUUID } from "node:crypto";

import { FileArtifactRepository } from "../artifact-repository.js";
import { FileBackgroundJobRepository } from "../background-job-repository.js";
import { FileClarificationRequestRepository } from "../clarification-request-repository.js";
import { FileMarketCacheRepository } from "../market-cache-repository.js";
import { FileReviewerScanRepository } from "../reviewer-scan-repository.js";
import { createServer } from "../server.js";
import { registerTelegramWebhook } from "../telegram-bot-client.js";

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
const upcomingReviewerScansPath = resolvePathFromEnv(
  "UPCOMING_REVIEWER_SCANS_PATH",
  "../../data/upcoming-reviewer-scans.json"
);

const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const llmRuntime = resolveLlmRuntime();

const server = createServer({
  clarificationRequestRepository: new FileClarificationRequestRepository(
    clarificationRequestsPath
  ),
  artifactRepository: new FileArtifactRepository(artifactsPath),
  backgroundJobRepository: new FileBackgroundJobRepository(backgroundJobsPath),
  reviewerScanRepository: new FileReviewerScanRepository(reviewerScansPath),
  marketCacheRepository: new FileMarketCacheRepository(marketCachePath),
  upcomingMarketCacheRepository: new FileMarketCacheRepository(upcomingMarketCachePath),
  upcomingReviewerScanRepository: new FileReviewerScanRepository(upcomingReviewerScansPath),
  now: () => new Date(),
  createClarificationId: () => createId("clar"),
  createBackgroundJobId: () => createId("job"),
  reviewerAuthToken: process.env.REVIEWER_AUTH_TOKEN,
  llmRuntime,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramBotApiBaseUrl: process.env.TELEGRAM_BOT_API_BASE_URL,
  llmTraceability: {
    promptTemplateVersion:
      process.env.LLM_PROMPT_TEMPLATE_VERSION ?? "reviewer-offchain-prompt-v1",
    modelId: process.env.LLM_MODEL_ID ?? llmRuntime.model,
    processingVersion: process.env.LLM_PROCESSING_VERSION ?? "offchain-llm-pipeline-v1"
  }
});

async function maybeRegisterTelegramWebhook() {
  if (!process.env.TELEGRAM_WEBHOOK_URL) {
    return;
  }

  const result = await registerTelegramWebhook({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
    apiBaseUrl: process.env.TELEGRAM_BOT_API_BASE_URL
  });

  console.log(`telegram webhook registered: ${result.webhookUrl}`);
}

await maybeRegisterTelegramWebhook();

server.listen(port, host, () => {
  const address = server.address();
  const resolvedPort =
    typeof address === "object" && address !== null ? address.port : port;

  console.log(`offchain-backend listening on http://${host}:${resolvedPort}`);
  console.log(`market cache: ${marketCachePath}`);
  console.log(`clarification store: ${clarificationRequestsPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
