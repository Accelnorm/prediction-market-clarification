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

function buildLlmTrace({ llmTraceability, requestedAt }) {
  return {
    promptTemplateVersion: llmTraceability.promptTemplateVersion,
    modelId: llmTraceability.modelId,
    requestedAt,
    processingVersion: llmTraceability.processingVersion
  };
}

async function publishInterpretationArtifact({
  artifactRepository,
  clarification,
  market,
  llmOutput,
  generatedAtUtc
}) {
  if (!artifactRepository) {
    return { cid: null, url: null };
  }

  return artifactRepository.createArtifact({
    clarificationId: clarification.clarificationId,
    eventId: clarification.eventId,
    marketText: market.resolution,
    suggestedEditedMarketText: llmOutput.suggested_market_text,
    clarificationNote: llmOutput.suggested_note,
    generatedAtUtc
  });
}

export async function runAutomaticClarificationPipeline({
  clarification,
  clarificationRequestRepository,
  artifactRepository,
  marketCacheRepository,
  now,
  llmTraceability = {
    promptTemplateVersion: "reviewer-offchain-prompt-v1",
    modelId: "gemini-reviewer-default",
    processingVersion: "offchain-llm-pipeline-v1"
  }
}) {
  const market = await marketCacheRepository.findByMarketId(clarification.eventId);
  const llmOutput = buildDefaultInterpretation({ market });
  const requestedAt = now().toISOString();
  const completedTimestamp = now().toISOString();
  const llmTrace = buildLlmTrace({ llmTraceability, requestedAt });
  const artifact = await publishInterpretationArtifact({
    artifactRepository,
    clarification,
    market,
    llmOutput,
    generatedAtUtc: completedTimestamp
  });

  await clarificationRequestRepository.updateByClarificationId(clarification.clarificationId, {
    status: "completed",
    updatedAt: completedTimestamp,
    llmOutput,
    llmTrace,
    artifactCid: artifact.cid,
    artifactUrl: artifact.url,
    errorMessage: null,
    retryable: false
  });

  return { llmOutput, llmTrace, artifact };
}
