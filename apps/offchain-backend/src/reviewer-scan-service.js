import { generateMarketInterpretation } from "./llm-provider.js";
import { buildAdaptiveReviewWindow } from "./review-window-policy.js";

function buildRecommendation(llmOutput) {
  return llmOutput.ambiguity_score >= 0.5 ? "review" : "monitor";
}

export async function createReviewerMarketScan({
  jobId,
  eventId,
  marketCacheRepository,
  reviewerScanRepository,
  now,
  llmRuntime
}) {
  const market = await marketCacheRepository.findByMarketId(eventId);

  if (!market) {
    const error = new Error("Event id must match an active synced market before a scan can run.");
    error.statusCode = 404;
    error.code = "UNSUPPORTED_EVENT_ID";
    throw error;
  }

  const createdAt = now().toISOString();
  const { llmOutput } = await generateMarketInterpretation({
    clarification: {
      clarificationId: null,
      eventId,
      question: `Review this market for ambiguity and suggest clarifying edits.`
    },
    market,
    llmRuntime
  });
  const reviewWindow = buildAdaptiveReviewWindow({
    clarification: {
      llmOutput
    },
    market,
    now: new Date(createdAt)
  });
  const scan = {
    scanId: `scan_${eventId}_${createdAt}`,
    jobId: jobId ?? null,
    eventId,
    createdAt,
    ambiguity_score: llmOutput.ambiguity_score,
    recommendation: buildRecommendation(llmOutput),
    flagged_clauses: [llmOutput.cited_clause],
    suggested_market_text: llmOutput.suggested_market_text,
    suggested_note: llmOutput.suggested_note,
    review_window: reviewWindow
  };

  await reviewerScanRepository.create(scan);

  return scan;
}
