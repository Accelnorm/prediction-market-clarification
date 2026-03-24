const PLACEHOLDER_SOLANA_RECIPIENT = "11111111111111111111111111111111";

function normalizeString(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

function isTruthyEnv(value: any) {
  return value === "1" || value === "true";
}

function validationError(message: any) {
  return Object.assign(new Error(message), { code: "INVALID_RUNTIME_CONFIG" });
}

function hasPayAIApiKeys(x402PaymentConfig: any) {
  return (
    normalizeString(x402PaymentConfig?.payaiApiKeyId) &&
    normalizeString(x402PaymentConfig?.payaiApiKeySecret)
  );
}

export function isProductionRuntime(env: any = process.env) {
  return (
    normalizeString(env.APP_ENV).toLowerCase() === "production" ||
    normalizeString(env.NODE_ENV).toLowerCase() === "production"
  );
}

export function resolvePhase2RoutesEnabled(env: any = process.env) {
  return isTruthyEnv(normalizeString(env.ENABLE_PHASE2_REVIEWER_ROUTES).toLowerCase());
}

export function resolveTelegramEnabled(env: any = process.env) {
  return isTruthyEnv(normalizeString(env.ENABLE_TELEGRAM_ROUTES).toLowerCase());
}

export function resolveClarificationFinalityConfig(env: any = process.env) {
  const mode = normalizeString(env.CLARIFICATION_FINALITY_MODE).toLowerCase() === "dynamic"
    ? "dynamic"
    : "static";
  const parsedStaticSecs = Number.parseInt(env.CLARIFICATION_FINALITY_STATIC_SECS ?? "86400", 10);

  return {
    mode,
    staticWindowSecs: Number.isFinite(parsedStaticSecs) ? parsedStaticSecs : 86400,
    processingActivityEnabled: isTruthyEnv(
      normalizeString(env.CLARIFICATION_PROCESSING_ACTIVITY_ENABLED).toLowerCase()
    )
  };
}

export function validateProductionRuntimeConfig({
  env = process.env,
  llmRuntime,
  x402PaymentConfig,
  artifactPublicationConfig = { provider: "disabled", enabled: false } as { provider: string; enabled: boolean; ipfsApiUrl?: string | null },
  telegramEnabled = false,
  hasDatabase = false
}: any) {
  if (!isProductionRuntime(env)) {
    return;
  }

  if (!hasDatabase) {
    throw validationError("DATABASE_URL is required in production.");
  }

  if (!normalizeString(llmRuntime?.apiKey)) {
    throw validationError("A real LLM API key is required in production.");
  }

  if (!normalizeString(x402PaymentConfig?.recipientAddress)) {
    throw validationError("X402_RECIPIENT_ADDRESS is required in production.");
  }

  if (x402PaymentConfig.recipientAddress === PLACEHOLDER_SOLANA_RECIPIENT) {
    throw validationError("X402_RECIPIENT_ADDRESS cannot use the placeholder recipient in production.");
  }

  if (!normalizeString(x402PaymentConfig?.network)) {
    throw validationError("X402_NETWORK is required in production.");
  }

  if (!normalizeString(x402PaymentConfig?.mintAddress)) {
    throw validationError("X402_MINT_ADDRESS is required in production.");
  }

  if (artifactPublicationConfig?.provider === "ipfs") {
    if (!normalizeString(artifactPublicationConfig.ipfsApiUrl)) {
      throw validationError("IPFS_API_URL is required when ARTIFACT_PUBLICATION_PROVIDER=ipfs.");
    }
  }

  if (telegramEnabled) {
    if (!normalizeString(env.TELEGRAM_BOT_TOKEN)) {
      throw validationError("TELEGRAM_BOT_TOKEN is required when Telegram is enabled.");
    }

    if (!normalizeString(env.TELEGRAM_WEBHOOK_URL)) {
      throw validationError("TELEGRAM_WEBHOOK_URL is required when Telegram is enabled.");
    }

    if (!normalizeString(env.TELEGRAM_WEBHOOK_SECRET)) {
      throw validationError("TELEGRAM_WEBHOOK_SECRET is required when Telegram is enabled.");
    }
  }
}
