// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { loadLlmRuntime } from "../src/llm-runtime-config.js";

test("loadLlmRuntime falls back to the default OpenRouter base URL when the env var is blank", () => {
  const runtime = loadLlmRuntime({
    LLM_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "key",
    OPENROUTER_BASE_URL: "",
    OPENROUTER_APP_URL: "",
    OPENROUTER_APP_NAME: ""
  });

  assert.deepEqual(runtime, {
    provider: "openrouter",
    apiKey: "key",
    model: "openrouter/auto",
    baseUrl: "https://openrouter.ai/api/v1",
    appUrl: null,
    appName: "gemini-pm"
  });
});
