import { fetchTradesForSymbol } from "./gemini-markets-source.js";

const DEFAULT_FINALITY_CONFIG = {
  mode: "static",
  staticWindowSecs: 86400,
  processingActivityEnabled: false
};

function normalizeFinalityConfig(config = {}) {
  const mode = config.mode === "dynamic" ? "dynamic" : "static";
  const staticWindowSecs = Number.isFinite(config.staticWindowSecs)
    ? Math.max(3600, Math.min(86400, Math.round(config.staticWindowSecs)))
    : DEFAULT_FINALITY_CONFIG.staticWindowSecs;

  return {
    mode,
    staticWindowSecs,
    processingActivityEnabled:
      typeof config.processingActivityEnabled === "boolean"
        ? config.processingActivityEnabled
        : mode === "dynamic"
  };
}

function parseTradeAmount(trade) {
  const parsed = Number.parseFloat(String(trade?.amount ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTradeTimestampMs(trade) {
  const timestampMs = Number(trade?.timestampms ?? trade?.timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function computeTradeMetrics(trades = [], nowDate) {
  const nowMs = nowDate.getTime();
  const oneDayAgoMs = nowMs - 24 * 60 * 60 * 1000;
  let tradeCountWindow = 0;
  let shareVolumeWindow = 0;
  let lastTradeMs = null;

  for (const trade of trades) {
    const timestampMs = getTradeTimestampMs(trade);
    if (!timestampMs) {
      continue;
    }

    if (lastTradeMs === null || timestampMs > lastTradeMs) {
      lastTradeMs = timestampMs;
    }

    if (timestampMs >= oneDayAgoMs) {
      tradeCountWindow += 1;
      shareVolumeWindow += parseTradeAmount(trade);
    }
  }

  return {
    tradeCountWindow,
    shareVolumeWindow,
    lastTradeAt: lastTradeMs ? new Date(lastTradeMs).toISOString() : null
  };
}

function getTradeSignals(activity, nowDate) {
  const lastTradeMs =
    typeof activity?.lastTradeAt === "string" ? Date.parse(activity.lastTradeAt) : Number.NaN;
  const minutesSinceLastTrade = Number.isFinite(lastTradeMs)
    ? Math.max(0, Math.floor((nowDate.getTime() - lastTradeMs) / 60000))
    : null;

  return {
    lastTradeAt: activity?.lastTradeAt ?? null,
    tradeCountWindow: activity?.tradeCountWindow ?? 0,
    shareVolumeWindow: activity?.shareVolumeWindow ?? 0,
    activeInstrumentCountWindow: activity?.activeInstrumentCountWindow ?? 0,
    minutesSinceLastTrade
  };
}

function computeProcessingUrgency({ market, activity, nowDate }) {
  const tradeSignals = getTradeSignals(activity, nowDate);
  const closesAtMs =
    typeof market?.closesAt === "string" ? Date.parse(market.closesAt) : Number.NaN;
  const hoursToClose = Number.isFinite(closesAtMs)
    ? Math.max(0, Math.floor((closesAtMs - nowDate.getTime()) / (60 * 60 * 1000)))
    : null;
  const volumeUsd = Number.parseFloat(String(market?.volumeUsd ?? ""));
  let urgency = "normal";
  const reasons = [];

  if (hoursToClose !== null && hoursToClose <= 24) {
    urgency = "high";
    reasons.push("Market closes within 24 hours.");
  }

  if (tradeSignals.minutesSinceLastTrade !== null && tradeSignals.minutesSinceLastTrade <= 10) {
    urgency = "high";
    reasons.push("Recent trade activity within 10 minutes.");
  }

  if (Number.isFinite(volumeUsd) && volumeUsd >= 100000) {
    urgency = "high";
    reasons.push("High event volume on Gemini.");
  }

  if (reasons.length === 0) {
    reasons.push("No elevated urgency signals detected.");
  }

  return {
    processingUrgency: urgency,
    processingUrgencyReason: reasons.join(" "),
    tradeContextAsOf: activity?.lastFetchedAt ?? null
  };
}

function computeDynamicFinalityWindow({ clarification, market, activity, nowDate }) {
  const tradeSignals = getTradeSignals(activity, nowDate);
  const ambiguityScore =
    typeof clarification?.llmOutput?.ambiguity_score === "number"
      ? clarification.llmOutput.ambiguity_score
      : 0;
  const closesAtMs =
    typeof market?.closesAt === "string" ? Date.parse(market.closesAt) : Number.NaN;
  const hoursToClose = Number.isFinite(closesAtMs)
    ? Math.max(0, Math.floor((closesAtMs - nowDate.getTime()) / (60 * 60 * 1000)))
    : null;
  const volumeUsd = Number.parseFloat(String(market?.volumeUsd ?? ""));
  const liquidityUsd = Number.parseFloat(String(market?.liquidityUsd ?? ""));
  let score = 0;
  const reasons = [];

  if (hoursToClose !== null && hoursToClose <= 24) {
    score += 3;
    reasons.push("Near expiry.");
  } else if (hoursToClose !== null && hoursToClose <= 72) {
    score += 2;
    reasons.push("Closing within 72 hours.");
  }

  if (tradeSignals.minutesSinceLastTrade !== null && tradeSignals.minutesSinceLastTrade <= 10) {
    score += 3;
    reasons.push("Recent trades within 10 minutes.");
  } else if (tradeSignals.minutesSinceLastTrade !== null && tradeSignals.minutesSinceLastTrade <= 60) {
    score += 2;
    reasons.push("Recent trades within 60 minutes.");
  }

  if (tradeSignals.shareVolumeWindow >= 5000) {
    score += 3;
    reasons.push("High 24h share volume.");
  } else if (tradeSignals.shareVolumeWindow >= 500) {
    score += 2;
    reasons.push("Moderate 24h share volume.");
  }

  if (Number.isFinite(volumeUsd) && volumeUsd >= 100000) {
    score += 2;
    reasons.push("High event USD volume.");
  }

  if (Number.isFinite(liquidityUsd) && liquidityUsd >= 50000) {
    score += 1;
    reasons.push("High event liquidity.");
  }

  if (ambiguityScore >= 0.8) {
    score += 1;
    reasons.push("High LLM ambiguity.");
  }

  let finalityWindowSecs = 86400;

  if (score >= 8) {
    finalityWindowSecs = 3600;
  } else if (score >= 5) {
    finalityWindowSecs = 21600;
  } else if (score >= 3) {
    finalityWindowSecs = 43200;
  }

  return {
    finalityMode: "dynamic",
    finalityWindowSecs,
    finalityReason:
      reasons.length > 0
        ? reasons.join(" ") + ` Final window ${finalityWindowSecs} seconds.`
        : `Dynamic mode selected final window ${finalityWindowSecs} seconds.`,
    marketImportanceScore: score,
    marketImportanceSignals: {
      hoursToClose,
      volumeUsd: Number.isFinite(volumeUsd) ? String(volumeUsd) : null,
      liquidityUsd: Number.isFinite(liquidityUsd) ? String(liquidityUsd) : null,
      ...tradeSignals,
      ambiguityScore
    }
  };
}

function computeStaticFinalityWindow(config) {
  return {
    finalityMode: "static",
    finalityWindowSecs: config.staticWindowSecs,
    finalityReason: `Static finality window configured at ${config.staticWindowSecs} seconds.`,
    marketImportanceScore: null,
    marketImportanceSignals: {}
  };
}

export async function refreshTradeActivityForMarket({
  market,
  tradeActivityRepository,
  fetchTrades = fetchTradesForSymbol,
  now = () => new Date()
}) {
  if (!market?.marketId || !Array.isArray(market?.contracts) || market.contracts.length === 0) {
    return null;
  }

  const existingActivity =
    (await tradeActivityRepository?.findByEventId?.(market.marketId)) ?? {
      eventId: market.marketId,
      instruments: {}
    };
  const nowDate = now();
  const instruments = {};
  let combinedTrades = [];

  for (const contract of market.contracts) {
    if (typeof contract?.instrumentSymbol !== "string" || contract.instrumentSymbol === "") {
      continue;
    }

    const existingInstrument = existingActivity?.instruments?.[contract.instrumentSymbol] ?? null;
    const trades = await fetchTrades(contract.instrumentSymbol, {
      sinceTid: existingInstrument?.lastTid ?? null
    });
    const filteredTrades = trades.filter((trade) => Number(trade?.tid) !== Number(existingInstrument?.lastTid));
    const allTrades = [...(existingInstrument?.recentTrades ?? []), ...filteredTrades]
      .filter((trade) => {
        const timestampMs = getTradeTimestampMs(trade);
        return timestampMs !== null && timestampMs >= nowDate.getTime() - 24 * 60 * 60 * 1000;
      })
      .sort((left, right) => Number(right.tid ?? 0) - Number(left.tid ?? 0))
      .slice(0, 500);

    combinedTrades.push(...allTrades);
    instruments[contract.instrumentSymbol] = {
      instrumentSymbol: contract.instrumentSymbol,
      lastTid:
        allTrades.reduce((maxTid, trade) => Math.max(maxTid, Number(trade?.tid ?? 0)), Number(existingInstrument?.lastTid ?? 0)) ||
        null,
      recentTrades: allTrades,
      lastFetchedAt: nowDate.toISOString()
    };
  }

  const metrics = computeTradeMetrics(combinedTrades, nowDate);
  const activity = {
    eventId: market.marketId,
    ...metrics,
    activeInstrumentCountWindow: Object.values(instruments).filter(
      (instrument) => Array.isArray(instrument.recentTrades) && instrument.recentTrades.length > 0
    ).length,
    lastFetchedAt: nowDate.toISOString(),
    instruments
  };

  await tradeActivityRepository?.upsert?.(activity);
  return activity;
}

export async function buildClarificationTiming({
  clarification,
  market,
  tradeActivityRepository,
  fetchTrades = fetchTradesForSymbol,
  now = () => new Date(),
  finalityConfig = DEFAULT_FINALITY_CONFIG
}) {
  const resolvedConfig = normalizeFinalityConfig(finalityConfig);
  const nowDate = now();
  let activity = (await tradeActivityRepository?.findByEventId?.(market?.marketId)) ?? null;

  if (
    resolvedConfig.processingActivityEnabled &&
    market?.status === "active" &&
    Array.isArray(market?.contracts) &&
    market.contracts.some((contract) => typeof contract?.instrumentSymbol === "string" && contract.instrumentSymbol !== "")
  ) {
    activity = await refreshTradeActivityForMarket({
      market,
      tradeActivityRepository,
      fetchTrades,
      now
    });
  }

  const processing = computeProcessingUrgency({
    market,
    activity,
    nowDate
  });
  const finality =
    resolvedConfig.mode === "dynamic"
      ? computeDynamicFinalityWindow({
          clarification,
          market,
          activity,
          nowDate
        })
      : computeStaticFinalityWindow(resolvedConfig);

  return {
    ...processing,
    ...finality
  };
}
