import {
  paymentRequiredError,
  validationError
} from "./x402-paid-clarification.js";
import { buildClarificationPaymentRequirements } from "./x402-payment-challenge.js";
import { createPayAIAuthHeaders } from "@payai/facilitator";
import type { X402PaymentConfig } from "./x402-payment-challenge.js";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toBase64Value(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tryDecodeBase64Json(value: string) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function paymentVerificationError(statusCode: number, code: string, message: string, details: unknown = null) {
  const extra: Record<string, unknown> = { statusCode, code };
  if (details !== null) {
    extra.details = details;
  }
  return Object.assign(new Error(message), extra);
}

function parsePaymentPayload(rawValue: unknown) {
  const normalized = normalizeString(rawValue);

  if (!normalized) {
    return null;
  }

  const fromJson = tryParseJson(normalized);

  if (fromJson) {
    return {
      headerValue: normalized,
      paymentPayload: fromJson
    };
  }

  const fromBase64 = tryDecodeBase64Json(normalized);

  if (fromBase64) {
    return {
      headerValue: normalized,
      paymentPayload: fromBase64
    };
  }

  return null;
}

type IncomingRequest = {
  headers: Record<string, string | string[] | undefined>;
};

type RequestBody = {
  payment?: {
    proof?: unknown;
    reference?: unknown;
  };
} | null;

export function extractX402PaymentCandidate(request: IncomingRequest, body: RequestBody = null) {
  const paymentSignatureHeader = normalizeString(request.headers["payment-signature"]);
  const legacyPaymentHeader = normalizeString(request.headers["x-payment"]);
  const headerPayload = parsePaymentPayload(paymentSignatureHeader || legacyPaymentHeader);

  if (headerPayload) {
    return {
      proof: headerPayload.headerValue,
      paymentPayload: headerPayload.paymentPayload,
      paymentReference: normalizeString(body?.payment?.reference) || null,
      source: paymentSignatureHeader ? "payment-signature" : "x-payment"
    };
  }

  const legacyBodyProof = normalizeString(body?.payment?.proof);

  if (!legacyBodyProof) {
    return null;
  }

  const parsedBodyPayload = parsePaymentPayload(legacyBodyProof);
  const paymentPayload = parsedBodyPayload?.paymentPayload ?? {
    x402Version: 1,
    scheme: "exact",
    network: "solana:devnet",
    payload: {
      proof: legacyBodyProof
    }
  };

  return {
    proof: parsedBodyPayload?.headerValue ?? legacyBodyProof,
    paymentPayload,
    paymentReference: normalizeString(body?.payment?.reference) || null,
    source: "legacy-body"
  };
}

type PaymentCandidate = {
  proof: string;
  paymentPayload: Record<string, unknown>;
  paymentReference: string | null;
  source: string;
} | null;

type RequestContext = {
  eventId: string;
  requesterId?: string | null;
};

type VerifyWithFacilitatorOptions = {
  paymentCandidate: NonNullable<PaymentCandidate>;
  config: X402PaymentConfig & {
    payaiApiKeyId?: string | null;
    payaiApiKeySecret?: string | null;
    facilitatorAuthToken?: string | null;
    facilitatorUrl: string;
    x402Version: number;
  };
  requestContext: RequestContext;
  requestUrl?: { origin?: string } | null;
  fetchImpl: typeof fetch;
};

async function verifyWithFacilitator({
  paymentCandidate,
  config,
  requestContext,
  requestUrl,
  fetchImpl
}: VerifyWithFacilitatorOptions) {
  const paymentRequirements = buildClarificationPaymentRequirements({
    eventId: requestContext.eventId,
    requesterId: requestContext.requesterId,
    config,
    requestUrl
  });
  let authHeaders: Record<string, string> = {};

  if (config.payaiApiKeyId && config.payaiApiKeySecret) {
    authHeaders = (await createPayAIAuthHeaders(
      config.payaiApiKeyId,
      config.payaiApiKeySecret
    )()).verify;
  } else if (config.facilitatorAuthToken) {
    authHeaders = {
      authorization: `Bearer ${config.facilitatorAuthToken}`
    };
  }

  const verificationResponse = await fetchImpl(`${config.facilitatorUrl}/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders
    },
    body: JSON.stringify({
      x402Version: config.x402Version,
      paymentPayload: paymentCandidate.paymentPayload,
      paymentRequirements
    })
  });

  if (!verificationResponse.ok) {
    let responsePayload = null;

    try {
      responsePayload = await verificationResponse.json();
    } catch {
      responsePayload = null;
    }

    throw paymentVerificationError(
      502,
      "PAYMENT_VERIFICATION_FAILED",
      "The x402 facilitator could not verify this payment.",
      responsePayload
    );
  }

  return {
    payload: await verificationResponse.json(),
    paymentRequirements
  };
}

export type VerifyClarificationPaymentOptions = {
  paymentCandidate: PaymentCandidate;
  config: X402PaymentConfig & Record<string, unknown>;
  now: () => Date;
  requestContext: RequestContext;
  requestUrl?: { origin?: string } | null;
  fetchImpl?: typeof fetch;
};

export async function verifyClarificationPayment({
  paymentCandidate,
  config,
  now,
  requestContext,
  requestUrl,
  fetchImpl = fetch
}: VerifyClarificationPaymentOptions) {
  if (!paymentCandidate) {
    throw paymentRequiredError();
  }

  if (!paymentCandidate.paymentPayload || typeof paymentCandidate.paymentPayload !== "object") {
    throw validationError("INVALID_PAYMENT_PROOF", "Payment proof must be valid x402 JSON.");
  }

  const { payload, paymentRequirements } = await verifyWithFacilitator({
    paymentCandidate,
    config: config as VerifyWithFacilitatorOptions["config"],
    requestContext,
    requestUrl,
    fetchImpl
  });

  if (!payload?.isValid) {
    throw paymentVerificationError(
      402,
      "INVALID_PAYMENT",
      payload?.invalidMessage ?? "The supplied x402 payment proof is invalid.",
      {
        invalidReason: payload?.invalidReason ?? null,
        payer: payload?.payer ?? null
      }
    );
  }

  const paymentProof = paymentCandidate.proof;
  const paymentReference =
    paymentCandidate.paymentReference ?? payload?.paymentReference ?? payload?.payer ?? paymentProof;

  return {
    paymentProof,
    paymentReference,
    paymentAmount: config.priceUsd,
    paymentAsset: config.assetSymbol,
    paymentMint: config.mintAddress,
    paymentCluster: config.cluster,
    paymentRecipient: config.recipientAddress,
    paymentTransactionSignature:
      normalizeString(payload?.transactionSignature) ||
      normalizeString(payload?.signature) ||
      normalizeString(payload?.transactionHash) ||
      null,
    paymentVerifiedAt: now().toISOString(),
    paymentSettledAt: normalizeString(payload?.settledAt) || null,
    paymentPayer: normalizeString(payload?.payer) || null,
    verificationSource: config.verificationSource,
    verificationStatus: "verified",
    paymentRequirements,
    paymentResponseHeader: toBase64Value(
      JSON.stringify({
        x402Version: config.x402Version,
        success: true,
        payer: payload?.payer ?? null
      })
    ),
    rawVerificationResult: payload,
    rawPaymentPayload: paymentCandidate.paymentPayload
  };
}
