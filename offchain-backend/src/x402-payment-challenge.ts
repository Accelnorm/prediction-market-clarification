function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toUsdcBaseUnits(amount: unknown): string {
  const normalized = normalizeString(amount);

  if (!normalized) {
    return "0";
  }

  const [wholePart = "0", fractionalPart = ""] = normalized.split(".");
  const paddedFractionalPart = `${fractionalPart}000000`.slice(0, 6);
  const combined = `${wholePart}${paddedFractionalPart}`.replace(/^0+(?=\d)/, "");

  return combined || "0";
}

function joinUrl(baseUrl: string | null | undefined, pathname: string): string {
  if (!baseUrl) {
    return pathname;
  }

  return new URL(pathname, baseUrl).toString();
}

export type X402PaymentConfig = {
  resourceBaseUrl?: string | null;
  feePayer?: string | null;
  x402Version: number;
  scheme: string;
  network: string;
  priceUsd: unknown;
  maxAmountRequired: string;
  mintAddress: string;
  assetSymbol: string;
  recipientAddress: string;
  maxTimeoutSeconds: number;
  cluster: string;
};

export type BuildPaymentRequirementsOptions = {
  eventId: string;
  requesterId?: string | null;
  config: X402PaymentConfig;
  requestUrl?: { origin?: string } | null;
};

export function buildClarificationPaymentRequirements({
  eventId,
  requesterId,
  config,
  requestUrl
}: BuildPaymentRequirementsOptions) {
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

export function buildX402PaymentRequiredPayload({ eventId, requesterId, config, requestUrl }: BuildPaymentRequirementsOptions) {
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

export function buildX402PaymentRequiredHeader(payload: { paymentRequirements?: Array<Record<string, unknown>> }) {
  const paymentRequirements = payload.paymentRequirements ?? [];
  const primaryRequirement = paymentRequirements[0] ?? null;

  return {
    x402Version: primaryRequirement?.x402Version ?? 2,
    accepts: paymentRequirements,
    resource: primaryRequirement?.resource ?? null,
    extensions: {}
  };
}
