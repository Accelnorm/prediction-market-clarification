import {
  buildDefaultInterpretation,
  generateMarketInterpretation
} from "./llm-provider.js";
import { buildClarificationTiming } from "./clarification-timing.js";

export { buildDefaultInterpretation } from "./llm-provider.js";

function buildLlmTrace({ llmTraceability, requestedAt }: any) {
  return {
    promptTemplateVersion: llmTraceability.promptTemplateVersion,
    modelId: llmTraceability.modelId,
    requestedAt,
    processingVersion: llmTraceability.processingVersion
  };
}

async function publishInterpretationArtifact({
  artifactRepository,
  artifactPublisher,
  clarification,
  market,
  llmOutput,
  generatedAtUtc
}: any) {
  if (!artifactRepository) {
    return { cid: null, url: null };
  }

  const artifactPayload = {
    clarificationId: clarification.clarificationId,
    eventId: clarification.eventId,
    marketText: market.resolution,
    suggestedEditedMarketText: llmOutput.suggested_market_text,
    clarificationNote: llmOutput.suggested_note,
    generatedAtUtc
  };
  const publication =
    (await artifactPublisher?.publishArtifact?.(artifactPayload)) ?? {
      publicationProvider: "disabled",
      publicationStatus: "disabled",
      publishedCid: null,
      publishedUrl: null,
      publishedUri: null,
      publishedAt: null,
      publicationError: null
    };

  return artifactRepository.createArtifact({
    ...artifactPayload,
    ...publication
  });
}

export async function runAutomaticClarificationPipeline({
  clarification,
  clarificationRequestRepository,
  artifactRepository,
  artifactPublisher,
  marketCacheRepository,
  resolveMarketByClarification = null as ((c: any) => Promise<any>) | null,
  tradeActivityRepository,
  clarificationFinalityConfig,
  now,
  llmRuntime,
  fetchTradesForSymbol,
  llmTraceability = {
    promptTemplateVersion: "issue-clarification-response-v1",
    modelId: "openrouter/auto",
    processingVersion: "offchain-llm-pipeline-v1"
  }
}: any) {
  const market = resolveMarketByClarification
    ? await resolveMarketByClarification(clarification)
    : await marketCacheRepository.findByMarketId(clarification.eventId);
  const requestedAt = now().toISOString();
  const interpretation = await generateMarketInterpretation({
    clarification,
    market,
    llmRuntime,
    promptProfile: "issue-clarification-response"
  });
  const completedTimestamp = now().toISOString();
  const llmTrace = buildLlmTrace({ llmTraceability, requestedAt });
  const artifact = await publishInterpretationArtifact({
    artifactRepository,
    artifactPublisher,
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
    artifactUrl: artifact.url ?? null,
    artifactPublicationProvider: artifact.publicationProvider ?? null,
    artifactPublicationStatus: artifact.publicationStatus ?? null,
    artifactPublishedCid: artifact.publishedCid ?? null,
    artifactPublishedUrl: artifact.publishedUrl ?? null,
    artifactPublishedUri: artifact.publishedUri ?? null,
    artifactPublishedAt: artifact.publishedAt ?? null,
    artifactPublicationError: artifact.publicationError ?? null,
    errorMessage: null,
    retryable: false
  });

  return { llmOutput: interpretation.llmOutput, llmTrace, artifact };
}
