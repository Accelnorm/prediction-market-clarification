import {
  buildDefaultInterpretation,
  generateMarketInterpretation
} from "./llm-provider.js";
import { buildClarificationTiming } from "./clarification-timing.js";

export { buildDefaultInterpretation } from "./llm-provider.js";

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
  tradeActivityRepository,
  clarificationFinalityConfig,
  now,
  llmRuntime,
  fetchTradesForSymbol,
  llmTraceability = {
    promptTemplateVersion: "reviewer-offchain-prompt-v1",
    modelId: "openrouter/auto",
    processingVersion: "offchain-llm-pipeline-v1"
  }
}) {
  const market = await marketCacheRepository.findByMarketId(clarification.eventId);
  const requestedAt = now().toISOString();
  const interpretation = await generateMarketInterpretation({
    clarification,
    market,
    llmRuntime
  });
  const completedTimestamp = now().toISOString();
  const llmTrace = buildLlmTrace({ llmTraceability, requestedAt });
  const artifact = await publishInterpretationArtifact({
    artifactRepository,
    clarification,
    market,
    llmOutput: interpretation.llmOutput,
    generatedAtUtc: completedTimestamp
  });
  const timing = await buildClarificationTiming({
    clarification: {
      ...clarification,
      llmOutput: interpretation.llmOutput
    },
    market,
    tradeActivityRepository,
    finalityConfig: clarificationFinalityConfig,
    now,
    fetchTrades: fetchTradesForSymbol
  });

  await clarificationRequestRepository.updateByClarificationId(clarification.clarificationId, {
    status: "completed",
    updatedAt: completedTimestamp,
    llmOutput: interpretation.llmOutput,
    llmTrace,
    timing,
    artifactCid: artifact.cid,
    artifactUrl: artifact.url,
    errorMessage: null,
    retryable: false
  });

  return { llmOutput: interpretation.llmOutput, llmTrace, artifact };
}
