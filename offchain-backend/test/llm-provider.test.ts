import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultInterpretation,
  generateMarketInterpretation,
  normalizeInterpretation
} from "../src/llm-provider.js";

const MARKET = {
  marketId: "gm_btc_above_100k",
  title: "Will BTC trade above $100,000 before year end?",
  resolution: "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
  closesAt: "2026-12-31T23:59:00.000Z"
};

const CLARIFICATION = {
  clarificationId: "clar_001",
  eventId: "gm_btc_above_100k",
  question: "Should Gemini auction prints count?"
};

test("generateMarketInterpretation falls back to the deterministic interpretation when no API key is configured", async () => {
  const result = await generateMarketInterpretation({
    clarification: CLARIFICATION,
    market: MARKET,
    llmRuntime: {
      provider: "openrouter",
      model: "openrouter/auto"
    }
  });

  assert.deepEqual(result, {
    llmOutput: buildDefaultInterpretation({ market: MARKET }),
    providerUsed: "stub",
    modelId: "openrouter/auto",
    usedFallback: true
  });
});

test("generateMarketInterpretation uses an OpenAI-compatible provider response when configured", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: unknown; options: unknown }> = [];

  globalThis.fetch = (async (url: unknown, options: unknown) => {
    requests.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          model: "openrouter/auto",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "needs_clarification",
                  llm_status: "completed",
                  reasoning: "The resolution text does not specify whether auction prints count.",
                  cited_clause: MARKET.resolution,
                  ambiguity_score: 0.81,
                  ambiguity_summary: "The qualifying Gemini trade source is underspecified.",
                  suggested_market_text:
                    "Will Gemini BTC/USD spot trade above $100,000 on the primary continuous order book before December 31 2026 23:59 UTC?",
                  suggested_note:
                    "Exclude auctions and use the first qualifying continuous-order-book trade."
                })
              }
            }
          ]
        };
      }
    };
  }) as unknown as typeof globalThis.fetch;

  try {
    const result = await generateMarketInterpretation({
      clarification: CLARIFICATION,
      market: MARKET,
      llmRuntime: {
        provider: "openrouter",
        apiKey: "openrouter-key",
        model: "openrouter/auto",
        baseUrl: "https://openrouter.test/api/v1",
        appName: "gemini-pm"
      }
    });

    assert.equal(result.providerUsed, "openrouter");
    assert.equal(result.modelId, "openrouter/auto");
    assert.equal(result.usedFallback, false);
    assert.equal(result.llmOutput.ambiguity_score, 0.81);
    assert.equal(
      (requests[0] as { url: string }).url,
      "https://openrouter.test/api/v1/chat/completions"
    );
    assert.equal((requests[0] as { options: { method: string } }).options.method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateMarketInterpretation loads the review-upcoming-market skill when requested", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: unknown; options: unknown }> = [];

  globalThis.fetch = (async (url: unknown, options: unknown) => {
    requests.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          model: "openrouter/auto",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "needs_clarification",
                  llm_status: "completed",
                  reasoning: "The deadline semantics are underspecified.",
                  cited_clause: MARKET.resolution,
                  ambiguity_score: 0.74,
                  ambiguity_summary: "The contract lacks a binding source and edge-case rule.",
                  suggested_market_text:
                    "Will Gemini BTC/USD spot trade above $100,000 on the primary Gemini BTC/USD order book before December 31 2026 23:59 UTC?",
                  suggested_note:
                    "Bind settlement to the primary Gemini BTC/USD order book and define the first qualifying trade."
                })
              }
            }
          ]
        };
      }
    };
  }) as unknown as typeof globalThis.fetch;

  try {
    await generateMarketInterpretation({
      clarification: CLARIFICATION,
      market: MARKET,
      llmRuntime: {
        provider: "openrouter",
        apiKey: "openrouter-key",
        model: "openrouter/auto",
        baseUrl: "https://openrouter.test/api/v1"
      },
      promptProfile: "review-upcoming-market"
    });

    const requestBody = JSON.parse((requests[0] as { options: { body: string } }).options.body);
    const systemPrompt = requestBody.messages[0].content;

    assert.match(systemPrompt, /# Review Upcoming Market/);
    assert.match(systemPrompt, /Return output that fits the repo's reviewer scan shape/);
    assert.match(systemPrompt, /# Upcoming Market Review Heuristics/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateMarketInterpretation loads the issue-clarification-response skill when requested", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: unknown; options: unknown }> = [];

  globalThis.fetch = (async (url: unknown, options: unknown) => {
    requests.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          model: "openrouter/auto",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "needs_clarification",
                  llm_status: "completed",
                  reasoning: "The contract does not say whether Gemini auction prints count.",
                  cited_clause: MARKET.resolution,
                  ambiguity_score: 0.76,
                  ambiguity_summary: "The qualifying Gemini print rule is not binding.",
                  suggested_market_text:
                    "Will Gemini BTC/USD spot trade above $100,000 on the primary Gemini BTC/USD continuous order book before December 31 2026 23:59 UTC?",
                  suggested_note:
                    "Exclude auctions and count only the first qualifying continuous-order-book execution."
                })
              }
            }
          ]
        };
      }
    };
  }) as unknown as typeof globalThis.fetch;

  try {
    await generateMarketInterpretation({
      clarification: CLARIFICATION,
      market: MARKET,
      llmRuntime: {
        provider: "openrouter",
        apiKey: "openrouter-key",
        model: "openrouter/auto",
        baseUrl: "https://openrouter.test/api/v1"
      },
      promptProfile: "issue-clarification-response"
    });

    const requestBody = JSON.parse((requests[0] as { options: { body: string } }).options.body);
    const systemPrompt = requestBody.messages[0].content;

    assert.match(systemPrompt, /# Issue Clarification Response/);
    assert.match(systemPrompt, /Return output with these exact keys/);
    assert.match(systemPrompt, /# Gemini Clarification Heuristics/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateMarketInterpretation uses an Anthropic-compatible provider response when configured", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: unknown; options: unknown }> = [];

  globalThis.fetch = (async (url: unknown, options: unknown) => {
    requests.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          model: "claude-sonnet-4-20250514",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "clear",
                llm_status: "completed",
                reasoning: "The current clause is specific enough if only continuous spot prints count.",
                cited_clause: MARKET.resolution,
                ambiguity_score: 0.34,
                ambiguity_summary: "The remaining ambiguity is limited.",
                suggested_market_text: MARKET.title,
                suggested_note: "State explicitly whether auctions are excluded."
              })
            }
          ]
        };
      }
    };
  }) as unknown as typeof globalThis.fetch;

  try {
    const result = await generateMarketInterpretation({
      clarification: CLARIFICATION,
      market: MARKET,
      llmRuntime: {
        provider: "anthropic-compatible",
        apiKey: "claude-key",
        model: "claude-sonnet-4-20250514",
        baseUrl: "https://anthropic.test",
        anthropicVersion: "2023-06-01"
      }
    });

    assert.equal(result.providerUsed, "anthropic-compatible");
    assert.equal(result.modelId, "claude-sonnet-4-20250514");
    assert.equal(result.usedFallback, false);
    assert.equal(result.llmOutput.verdict, "clear");
    assert.equal((requests[0] as { url: string }).url, "https://anthropic.test/v1/messages");
    assert.equal(
      (requests[0] as { options: { headers: Record<string, string> } }).options.headers["x-api-key"],
      "claude-key"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeInterpretation keeps rewrite fields optional for clear verdicts", () => {
  const normalized = normalizeInterpretation(
    {
      verdict: "clear",
      ambiguity_score: 0.18,
      reasoning: "The current rule already answers the question.",
      cited_clause: MARKET.resolution,
      ambiguity_summary: "The contract is already specific enough.",
      suggested_market_text: "",
      suggested_note: ""
    },
    { market: MARKET }
  );

  assert.deepEqual(normalized, {
    verdict: "clear",
    llm_status: "completed",
    reasoning: "The current rule already answers the question.",
    cited_clause: MARKET.resolution,
    ambiguity_score: 0.18,
    ambiguity_summary: "The contract is already specific enough.",
    suggested_market_text: null,
    suggested_note: null
  });
});

test("normalizeInterpretation clamps malformed model output into the expected schema", () => {
  const normalized = normalizeInterpretation(
    {
      verdict: "maybe",
      ambiguity_score: "1.4",
      reasoning: "",
      cited_clause: "",
      ambiguity_summary: "",
      suggested_market_text: "",
      suggested_note: ""
    },
    { market: MARKET }
  );

  assert.deepEqual(normalized, {
    verdict: "needs_clarification",
    llm_status: "completed",
    reasoning: "The market text leaves some room for interpretation and should be reviewed.",
    cited_clause: MARKET.resolution,
    ambiguity_score: 1,
    ambiguity_summary:
      "The current market wording may leave important interpretation details unspecified.",
    suggested_market_text: MARKET.title,
    suggested_note:
      "Clarify the exact Gemini source, qualifying trade condition, and time boundary."
  });
});
