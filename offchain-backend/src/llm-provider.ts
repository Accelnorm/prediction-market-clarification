// @ts-nocheck
import { readFile } from "node:fs/promises";

function validationError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function buildDefaultInterpretation({ market }) {
  return {
    verdict: "needs_clarification",
    llm_status: "completed",
    reasoning:
      "The market text depends on Gemini BTC/USD spot prints but leaves room for ambiguity around which Gemini price feed or session record is authoritative.",
    cited_clause: market.resolution,
    ambiguity_score: 0.72,
    ambiguity_summary:
      "The resolution source is named at a high level, but the exact qualifying Gemini print is not explicit.",
    suggested_market_text:
      "Will Gemini BTC/USD spot trade above $100,000 on the primary Gemini exchange feed before December 31 2026 23:59 UTC?",
    suggested_note:
      "Use Gemini's primary BTC/USD spot exchange feed and count the first eligible trade print above $100,000 before expiry."
  };
}

const PROMPT_PROFILE_FILES = {
  "issue-clarification-response": [
    "../../new-skills/issue-clarification-response/SKILL.md",
    "../../new-skills/issue-clarification-response/references/clarification-heuristics.md"
  ],
  "review-upcoming-market": [
    "../../new-skills/review-upcoming-market/SKILL.md",
    "../../new-skills/review-upcoming-market/references/review-heuristics.md"
  ]
};

const promptProfileCache = new Map();

function buildDefaultSystemPrompt() {
  return [
    "You are a prediction-market clarification reviewer.",
    "Analyze the market text and the user's question.",
    "Return only valid JSON with these exact keys:",
    "verdict, llm_status, reasoning, cited_clause, ambiguity_score, ambiguity_summary, suggested_market_text, suggested_note.",
    'Use verdict "clear" or "needs_clarification".',
    'Use llm_status "completed".',
    "ambiguity_score must be a number between 0 and 1.",
    "cited_clause must quote or restate the most relevant resolution clause.",
    "Do not include markdown fences or extra commentary."
  ].join(" ");
}

async function readPromptProfile(profile) {
  if (!profile || !PROMPT_PROFILE_FILES[profile]) {
    return buildDefaultSystemPrompt();
  }

  if (promptProfileCache.has(profile)) {
    return promptProfileCache.get(profile);
  }

  const promptPromise = (async () => {
    const sections = await Promise.all(
      PROMPT_PROFILE_FILES[profile].map((relativePath) =>
        readFile(new URL(relativePath, import.meta.url), "utf8")
      )
    );

    return [
      "You are a prediction-market clarification reviewer.",
      "Use the following repo skill instructions as the system prompt for this review.",
      ...sections
    ].join("\n\n");
  })();

  promptProfileCache.set(profile, promptPromise);

  try {
    return await promptPromise;
  } catch (error) {
    promptProfileCache.delete(profile);
    throw error;
  }
}

function buildUserPrompt({ clarification, market }) {
  return JSON.stringify(
    {
      task: "analyze_prediction_market_clarification",
      market: {
        marketId: market.marketId ?? null,
        title: market.title ?? null,
        resolution: market.resolution ?? market.resolutionText ?? null,
        description: market.description ?? null,
        closesAt: market.closesAt ?? market.endTime ?? null,
        url: market.url ?? null,
        category: market.category ?? null,
        termsLink: market.termsLink ?? null,
        contracts: Array.isArray(market.contracts) ? market.contracts : []
      },
      clarificationRequest: {
        clarificationId: clarification.clarificationId ?? null,
        eventId: clarification.eventId ?? null,
        question: clarification.question ?? null
      }
    },
    null,
    2
  );
}

function extractJsonObject(text) {
  if (typeof text !== "string") {
    throw validationError("LLM_INVALID_RESPONSE", "LLM response did not contain text.");
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const start = trimmed.indexOf("{");

  if (start === -1) {
    throw validationError("LLM_INVALID_RESPONSE", "LLM response did not contain JSON.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < trimmed.length; index += 1) {
    const character = trimmed[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }

      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, index + 1));
      }
    }
  }

  throw validationError("LLM_INVALID_RESPONSE", "LLM response JSON could not be parsed.");
}

function normalizeString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function normalizeScore(value, fallback = 0.5) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, Number.parseFloat(numeric.toFixed(2))));
}

export function normalizeInterpretation(payload, { market }) {
  const resolutionText = market.resolution ?? market.resolutionText ?? "";
  const ambiguityScore = normalizeScore(payload?.ambiguity_score, 0.5);
  const verdict =
    normalizeString(payload?.verdict, ambiguityScore >= 0.5 ? "needs_clarification" : "clear")
      .toLowerCase()
      .replace(/\s+/g, "_") === "clear"
      ? "clear"
      : "needs_clarification";

  return {
    verdict,
    llm_status: "completed",
    reasoning: normalizeString(
      payload?.reasoning,
      "The market text leaves some room for interpretation and should be reviewed."
    ),
    cited_clause: normalizeString(payload?.cited_clause, resolutionText),
    ambiguity_score: ambiguityScore,
    ambiguity_summary: normalizeString(
      payload?.ambiguity_summary,
      "The current market wording may leave important interpretation details unspecified."
    ),
    suggested_market_text: normalizeString(
      payload?.suggested_market_text,
      market.title ?? resolutionText
    ),
    suggested_note: normalizeString(
      payload?.suggested_note,
      "Clarify the exact Gemini source, qualifying trade condition, and time boundary."
    )
  };
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function callOpenAiCompatibleProvider({
  apiKey,
  baseUrl,
  model,
  systemPrompt,
  userPrompt,
  defaultHeaders = {}
}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...defaultHeaders
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    })
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw validationError(
      "LLM_PROVIDER_FAILED",
      payload?.error?.message ?? "OpenAI-compatible LLM request failed.",
      502
    );
  }

  return {
    text:
      payload?.choices?.[0]?.message?.content ??
      payload?.choices?.[0]?.text ??
      null,
    modelId: payload?.model ?? model
  };
}

async function callAnthropicCompatibleProvider({
  apiKey,
  baseUrl,
  model,
  anthropicVersion,
  systemPrompt,
  userPrompt
}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": anthropicVersion,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userPrompt
        }
      ]
    })
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw validationError(
      "LLM_PROVIDER_FAILED",
      payload?.error?.message ?? payload?.error?.type ?? "Anthropic-compatible LLM request failed.",
      502
    );
  }

  return {
    text: Array.isArray(payload?.content)
      ? payload.content
          .filter((item) => item?.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n")
      : null,
    modelId: payload?.model ?? model
  };
}

function resolveRuntime(llmRuntime = {}) {
  const provider = llmRuntime.provider ?? "openrouter";

  if (provider === "openrouter") {
    return {
      provider,
      apiKey: llmRuntime.apiKey ?? null,
      model: llmRuntime.model ?? "openrouter/auto",
      baseUrl: llmRuntime.baseUrl ?? "https://openrouter.ai/api/v1",
      defaultHeaders: {
        ...(llmRuntime.appUrl ? { "http-referer": llmRuntime.appUrl } : {}),
        ...(llmRuntime.appName ? { "x-title": llmRuntime.appName } : {})
      }
    };
  }

  if (provider === "openai-compatible") {
    return {
      provider,
      apiKey: llmRuntime.apiKey ?? null,
      model: llmRuntime.model ?? "gpt-4.1-mini",
      baseUrl: llmRuntime.baseUrl ?? "https://api.openai.com/v1",
      defaultHeaders: {}
    };
  }

  if (provider === "anthropic-compatible") {
    return {
      provider,
      apiKey: llmRuntime.apiKey ?? null,
      model: llmRuntime.model ?? "claude-sonnet-4-20250514",
      baseUrl: llmRuntime.baseUrl ?? "https://api.anthropic.com",
      anthropicVersion: llmRuntime.anthropicVersion ?? "2023-06-01"
    };
  }

  throw validationError("UNSUPPORTED_LLM_PROVIDER", `Unsupported LLM provider: ${provider}`);
}

export async function generateMarketInterpretation({
  clarification,
  market,
  llmRuntime,
  promptProfile = null
}) {
  const runtime = resolveRuntime(llmRuntime);

  if (!runtime.apiKey) {
    if (llmRuntime?.requireConfiguredProvider) {
      throw validationError(
        "LLM_PROVIDER_REQUIRED",
        "A configured LLM provider is required for this runtime.",
        503
      );
    }

    return {
      llmOutput: buildDefaultInterpretation({ market }),
      providerUsed: "stub",
      modelId: runtime.model,
      usedFallback: true
    };
  }

  const systemPrompt = await readPromptProfile(promptProfile);
  const userPrompt = buildUserPrompt({ clarification, market });
  const response =
    runtime.provider === "anthropic-compatible"
      ? await callAnthropicCompatibleProvider({
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          model: runtime.model,
          anthropicVersion: runtime.anthropicVersion,
          systemPrompt,
          userPrompt
        })
      : await callOpenAiCompatibleProvider({
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          model: runtime.model,
          systemPrompt,
          userPrompt,
          defaultHeaders: runtime.defaultHeaders
        });

  return {
    llmOutput: normalizeInterpretation(extractJsonObject(response.text), { market }),
    providerUsed: runtime.provider,
    modelId: response.modelId,
    usedFallback: false
  };
}
