import {
  buildDefaultInterpretation,
  generateMarketInterpretation
} from "./llm-provider.js";
import { buildClarificationTiming } from "./clarification-timing.js";
import type { ClarificationRequest, MarketRecord } from "./types.js";

export { buildDefaultInterpretation } from "./llm-provider.js";

type LlmTraceability = {
  promptTemplateVersion: string;
  modelId: string;
  processingVersion: string;
};

function buildLlmTrace({ llmTraceability, requestedAt }: { llmTraceability: LlmTraceability; requestedAt: string }) {
  return {
    promptTemplateVersion: llmTraceability.promptTemplateVersion,
    modelId: llmTraceability.modelId,
    requestedAt,
    processingVersion: llmTraceability.processingVersion
  };
}

type ArtifactPublicationResult = {
  publicationProvider?: string | null;
  publicationStatus?: string | null;
  publishedCid?: string | null;
  publishedUrl?: string | null;
  publishedUri?: string | null;
  publishedAt?: string | null;
  publicationError?: unknown;
  cid?: string | null;
  url?: string | null;
};

type ArtifactRepository = {
  createArtifact?: (payload: Record<string, unknown>) => Promise<ArtifactPublicationResult | unknown>;
} | null | undefined;

type ArtifactPublisher = {
  publishArtifact?: (payload: Record<string, unknown>) => Promise<ArtifactPublicationResult | unknown>;
} | null | undefined;

async function publishInterpretationArtifact({
  artifactRepository,
  artifactPublisher,
  clarification,
  market,
  llmOutput,
  generatedAtUtc
}: {
  artifactRepository: ArtifactRepository;
  artifactPublisher: ArtifactPublisher;
  clarification: ClarificationRequest;
  market: MarketRecord;
  llmOutput: Record<string, unknown>;
  generatedAtUtc: string;
}) {
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

  return ((await artifactRepository.createArtifact?.({
    ...artifactPayload,
    ...publication
  })) ?? { cid: null, url: null }) as ArtifactPublicationResult;
}

export type RunAutomaticClarificationPipelineOptions = {
  clarification: ClarificationRequest;
  clarificationRequestRepository: {
    updateByClarificationId: (clarificationId: string, updates: Record<string, unknown>) => Promise<unknown>;
  } | null;
  artifactRepository: unknown;
  artifactPublisher: unknown;
  marketCacheRepository: {
    findByMarketId?: (marketId: string) => Promise<MarketRecord | null>;
  } | null | undefined;
  resolveMarketByClarification?: ((c: ClarificationRequest) => Promise<MarketRecord | null>) | null;
  tradeActivityRepository?: unknown;
  clarificationFinalityConfig?: unknown;
  now: () => Date;
  llmRuntime: unknown;
  fetchTradesForSymbol?: unknown;
  llmTraceability?: LlmTraceability | unknown;
};

export async function runAutomaticClarificationPipeline({
  clarification,
  clarificationRequestRepository,
  artifactRepository,
  artifactPublisher,
  marketCacheRepository,
  resolveMarketByClarification = null,
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
}: RunAutomaticClarificationPipelineOptions) {
  const market = resolveMarketByClarification
    ? await resolveMarketByClarification(clarification)
    : await marketCacheRepository?.findByMarketId?.(clarification.eventId);
  const requestedAt = now().toISOString();
  const interpretation = await generateMarketInterpretation({
    clarification,
    market,
    llmRuntime: llmRuntime as Record<string, unknown>,
    promptProfile: "issue-clarification-response"
  });
  const completedTimestamp = now().toISOString();
  const llmTrace = buildLlmTrace({ llmTraceability: llmTraceability as LlmTraceability, requestedAt });
  const artifact = await publishInterpretationArtifact({
    artifactRepository: artifactRepository as ArtifactRepository,
    artifactPublisher: artifactPublisher as ArtifactPublisher,
    clarification,
    market: market as MarketRecord,
    llmOutput: interpretation.llmOutput as Record<string, unknown>,
    generatedAtUtc: completedTimestamp
  });
  const timing = await buildClarificationTiming({
    clarification: {
      ...clarification,
      llmOutput: interpretation.llmOutput
    },
    market,
    tradeActivityRepository,
    finalityConfig: clarificationFinalityConfig as Record<string, unknown> | undefined,
    now,
    fetchTrades: fetchTradesForSymbol as ((...args: unknown[]) => unknown) | undefined
  });

  await clarificationRequestRepository?.updateByClarificationId(clarification.clarificationId as string, {
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
