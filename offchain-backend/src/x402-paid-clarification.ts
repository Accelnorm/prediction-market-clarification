// @ts-nocheck
function createError({ statusCode, code, message, details = null }) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;

  if (details !== null) {
    error.details = details;
  }

  return error;
}

export function paymentRequiredError(details = null) {
  return createError({
    statusCode: 402,
    code: "PAYMENT_REQUIRED",
    message: "A verified x402 payment of 1.00 USDC is required before creating a clarification.",
    details
  });
}

export function validationError(code, message, details = null) {
  return createError({
    statusCode: 400,
    code,
    message,
    details
  });
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeQuestion(value) {
  return normalizeString(value).replace(/\s+/g, " ");
}

export const MAX_QUESTION_LENGTH = 500;

export function parseClarificationRequestInput(payload) {
  const requesterId = normalizeString(payload?.requesterId);
  const question = normalizeQuestion(payload?.question);

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
    question
  };
}
