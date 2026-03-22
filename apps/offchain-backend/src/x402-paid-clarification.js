function paymentRequiredError() {
  const error = new Error(
    "A verified x402 payment of 1.00 USDC is required before creating a clarification."
  );
  error.statusCode = 402;
  error.code = "PAYMENT_REQUIRED";
  return error;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function parsePaidClarificationRequest(payload) {
  const requesterId = normalizeString(payload?.requesterId);
  const question = normalizeString(payload?.question);
  const paymentProof = normalizeString(payload?.payment?.proof);
  const paymentReference = normalizeString(payload?.payment?.reference);
  const paymentAmount = normalizeString(payload?.payment?.amount);
  const paymentAsset = normalizeString(payload?.payment?.asset);
  const paymentVerified = payload?.payment?.verified === true;

  if (!paymentVerified || !paymentProof || !paymentReference) {
    throw paymentRequiredError();
  }

  if (paymentAmount !== "1.00" || paymentAsset !== "USDC") {
    throw paymentRequiredError();
  }

  return {
    requesterId,
    question,
    paymentAmount,
    paymentAsset,
    paymentProof,
    paymentReference
  };
}
