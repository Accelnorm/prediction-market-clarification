function createError({ statusCode, code, message, details = null }: any) {
  const extra: Record<string, any> = { statusCode, code };
  if (details !== null) {
    extra.details = details;
  }
  return Object.assign(new Error(message), extra);
}

export function paymentRequiredError(details: any = null) {
  return createError({
    statusCode: 402,
    code: "PAYMENT_REQUIRED",
    message: "A verified x402 payment of 1.00 USDC is required before creating a clarification.",
    details
  });
}

export function validationError(code: any, message: any, details: any = null) {
  return createError({
    statusCode: 400,
    code,
    message,
    details
  });
}

function normalizeString(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeQuestion(value: any) {
  return normalizeString(value).replace(/\s+/g, " ");
}

export const MAX_QUESTION_LENGTH = 500;

export function parseClarificationRequestInput(payload: any) {
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
