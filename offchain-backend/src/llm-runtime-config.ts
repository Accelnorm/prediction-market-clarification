// @ts-nocheck
function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function loadLlmRuntime(env = process.env) {
  const provider = normalizeString(env.LLM_PROVIDER) || "openrouter";

  if (provider === "openrouter") {
    return {
      provider,
      apiKey: normalizeString(env.OPENROUTER_API_KEY) || null,
      model: normalizeString(env.LLM_MODEL) || "openrouter/auto",
      baseUrl: normalizeString(env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1",
      appUrl: normalizeString(env.OPENROUTER_APP_URL) || null,
      appName: normalizeString(env.OPENROUTER_APP_NAME) || "gemini-pm"
    };
  }

  if (provider === "openai-compatible") {
    return {
      provider,
      apiKey: normalizeString(env.OPENAI_COMPATIBLE_API_KEY) || null,
      model: normalizeString(env.LLM_MODEL) || "gpt-4.1-mini",
      baseUrl:
        normalizeString(env.OPENAI_COMPATIBLE_BASE_URL) || "https://api.openai.com/v1"
    };
  }

  if (provider === "anthropic-compatible") {
    return {
      provider,
      apiKey: normalizeString(env.ANTHROPIC_API_KEY) || null,
      model: normalizeString(env.LLM_MODEL) || "claude-sonnet-4-20250514",
      baseUrl: normalizeString(env.ANTHROPIC_BASE_URL) || "https://api.anthropic.com",
      anthropicVersion: normalizeString(env.ANTHROPIC_VERSION) || "2023-06-01"
    };
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}
