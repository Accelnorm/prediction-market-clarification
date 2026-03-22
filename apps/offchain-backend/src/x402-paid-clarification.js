function paymentRequiredError() {
  const error = new Error(
    "A verified x402 payment of 1.00 USDC is required before creating a clarification."
  );
  error.statusCode = 402;
  error.code = "PAYMENT_REQUIRED";
  return error;
}

function validationError(code, message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeQuestion(value) {
  return normalizeString(value).replace(/\s+/g, " ");
}

export const MAX_QUESTION_LENGTH = 500;

export function parsePaidClarificationRequest(payload) {
  const requesterId = normalizeString(payload?.requesterId);
  const question = normalizeQuestion(payload?.question);
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

  if (!question) {
    throw validationError("INVALID_QUESTION", "Clarification question cannot be empty.");
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    throw validationError(
      "QUESTION_TOO_LONG",
      `Clarification question must be ${MAX_QUESTION_LENGTH} characters or fewer.`
    );
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
