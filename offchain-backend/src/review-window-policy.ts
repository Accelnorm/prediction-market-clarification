// @ts-nocheck
const POLICY_STEPS_SECS = [3600, 14400, 28800, 43200, 86400];
const VERY_HIGH_AMBIGUITY_THRESHOLD = 0.85;

function clampStepIndex(index) {
  return Math.max(0, Math.min(index, POLICY_STEPS_SECS.length - 1));
}

function getTimeToEndBucket(timeToEndSecs) {
  if (timeToEndSecs < 6 * 60 * 60) {
    return "lt_6h";
  }

  if (timeToEndSecs < 24 * 60 * 60) {
    return "between_6h_and_24h";
  }

  if (timeToEndSecs < 72 * 60 * 60) {
    return "between_24h_and_72h";
  }

  return "gt_72h";
}

function getBaseStepIndex(timeToEndBucket) {
  switch (timeToEndBucket) {
    case "lt_6h":
      return 1;
    case "between_6h_and_24h":
      return 2;
    case "between_24h_and_72h":
      return 3;
    case "gt_72h":
    default:
      return 4;
  }
}

function normalizeActivitySignal(activitySignal) {
  if (typeof activitySignal !== "string") {
    return "normal";
  }

  const normalized = activitySignal.trim().toLowerCase();

  if (["low", "normal", "high"].includes(normalized)) {
    return normalized;
  }

  return "normal";
}

function getAmbiguityScore(clarification) {
  const score = clarification?.llmOutput?.ambiguity_score;

  if (typeof score === "number" && Number.isFinite(score)) {
    return score;
  }

  return 0;
}

export function buildAdaptiveReviewWindow({ clarification, market, now }) {
  const ambiguityScore = getAmbiguityScore(clarification);
  const activitySignal = normalizeActivitySignal(market?.activitySignal);
  const closesAt = typeof market?.closesAt === "string" ? Date.parse(market.closesAt) : Number.NaN;
  const currentTime = now.getTime();
  const timeToEndSecs = Number.isFinite(closesAt)
    ? Math.max(0, Math.floor((closesAt - currentTime) / 1000))
    : Number.POSITIVE_INFINITY;
  const timeToEndBucket = getTimeToEndBucket(timeToEndSecs);
  let stepIndex = getBaseStepIndex(timeToEndBucket);
  const reasonParts = [
    `Base window set from ${timeToEndBucket} time-to-end bucket.`
  ];

  if (activitySignal === "high" && stepIndex > 0) {
    stepIndex -= 1;
    reasonParts.push("High activity reduced the review window by one policy step.");
  }

  if (
    ambiguityScore >= VERY_HIGH_AMBIGUITY_THRESHOLD &&
    ["lt_6h", "between_6h_and_24h"].includes(timeToEndBucket) &&
    stepIndex > 0
  ) {
    stepIndex -= 1;
    reasonParts.push(
      "Very high ambiguity near expiry reduced the review window by one additional step."
    );
  }

  const boundedStepIndex = clampStepIndex(stepIndex);
  const reviewWindowSecs = POLICY_STEPS_SECS[boundedStepIndex];

  reasonParts.push(
    `Final window ${reviewWindowSecs} seconds within 3600-86400 second policy bounds.`
  );

  return {
    review_window_secs: reviewWindowSecs,
    review_window_reason: reasonParts.join(" "),
    time_to_end_bucket: timeToEndBucket,
    activity_signal: activitySignal,
    ambiguity_score: ambiguityScore
  };
}
