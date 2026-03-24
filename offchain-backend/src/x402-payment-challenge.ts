// @ts-nocheck
function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toUsdcBaseUnits(amount) {
  const normalized = normalizeString(amount);

  if (!normalized) {
    return "0";
  }

  const [wholePart = "0", fractionalPart = ""] = normalized.split(".");
  const paddedFractionalPart = `${fractionalPart}000000`.slice(0, 6);
  const combined = `${wholePart}${paddedFractionalPart}`.replace(/^0+(?=\d)/, "");

  return combined || "0";
}

function joinUrl(baseUrl, pathname) {
  if (!baseUrl) {
    return pathname;
  }

  return new URL(pathname, baseUrl).toString();
}

export function buildClarificationPaymentRequirements({
  eventId,
  requesterId,
  config,
  requestUrl
}) {
  const resource = joinUrl(
    config.resourceBaseUrl ?? requestUrl?.origin ?? null,
    `/api/clarify/${encodeURIComponent(eventId)}`
  );
  const normalizedRequesterId = normalizeString(requesterId);

  return {
    ...(config.feePayer
      ? {
          feePayer: config.feePayer
        }
      : {}),
    x402Version: config.x402Version,
    scheme: config.scheme,
    network: config.network,
    amount: toUsdcBaseUnits(config.priceUsd),
    maxAmountRequired: config.maxAmountRequired,
    asset: config.mintAddress,
    assetSymbol: config.assetSymbol,
    description: `Create a clarification request for ${eventId}.`,
    mimeType: "application/json",
    payTo: config.recipientAddress,
    resource,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: {
      cluster: config.cluster,
      eventId,
      ...(config.feePayer
        ? {
            feePayer: config.feePayer
          }
        : {}),
      requesterId: normalizedRequesterId || null,
      purpose: "clarification_request"
    }
  };
}

export function buildX402PaymentRequiredPayload({ eventId, requesterId, config, requestUrl }) {
  const paymentRequirements = [
    buildClarificationPaymentRequirements({
      eventId,
      requesterId,
      config,
      requestUrl
    })
  ];

  return {
    ok: false,
    error: {
      code: "PAYMENT_REQUIRED",
      message: "A verified x402 payment of 1.00 USDC is required before creating a clarification."
    },
    paymentRequirements
  };
}

export function buildX402PaymentRequiredHeader(payload) {
  const primaryRequirement = payload.paymentRequirements[0] ?? null;

  return {
    x402Version: primaryRequirement?.x402Version ?? 2,
    accepts: payload.paymentRequirements,
    resource: primaryRequirement?.resource ?? null,
    extensions: {}
  };
}
