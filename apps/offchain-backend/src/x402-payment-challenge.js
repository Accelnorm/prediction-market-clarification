function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
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
    x402Version: config.x402Version,
    scheme: config.scheme,
    network: config.network,
    amount: config.priceUsd,
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
