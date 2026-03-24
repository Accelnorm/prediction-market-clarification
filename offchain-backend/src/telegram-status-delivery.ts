const TELEGRAM_STATUSES = new Set(["pending", "processing", "completed", "failed"]);

function validationError(code: any, message: any, statusCode: any = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function sanitizeFailureMessage() {
  return "Please retry later.";
}

export function parseTelegramStatusUpdate(payload: any) {
  const status = typeof payload?.status === "string" ? payload.status.trim() : "";

  if (!TELEGRAM_STATUSES.has(status)) {
    throw validationError(
      "INVALID_STATUS",
      "Status must be one of pending, processing, completed, or failed."
    );
  }

  const clarificationId =
    typeof payload?.clarificationId === "string" && payload.clarificationId.trim()
      ? payload.clarificationId.trim()
      : null;
  const summary =
    typeof payload?.summary === "string" && payload.summary.trim()
      ? payload.summary.trim()
      : null;
  const errorMessage =
    typeof payload?.errorMessage === "string" && payload.errorMessage.trim()
      ? payload.errorMessage.trim()
      : null;

  if (status === "completed") {
    if (!clarificationId) {
      throw validationError(
        "MISSING_CLARIFICATION_ID",
        "Completed Telegram status updates must include a clarificationId."
      );
    }

    if (!summary) {
      throw validationError(
        "MISSING_SUMMARY",
        "Completed Telegram status updates must include a concise summary."
      );
    }
  }

  return {
    status,
    clarificationId,
    summary,
    errorMessage
  };
}

export function buildTelegramDeliveryPayload(request: any) {
  switch (request.status) {
    case "pending":
      return {
        chatId: request.telegramChatId,
        text: `Clarification request ${request.requestId} is pending for market ${request.marketId}.`
      };
    case "processing":
      return {
        chatId: request.telegramChatId,
        text: `Clarification request ${request.requestId} is processing for market ${request.marketId}.`
      };
    case "completed":
      return {
        chatId: request.telegramChatId,
        text: `Clarification ${request.clarificationId} completed for request ${request.requestId}: ${request.summary}`
      };
    case "failed":
      return {
        chatId: request.telegramChatId,
        text: `Clarification request ${request.requestId} failed. ${sanitizeFailureMessage()}`
      };
    default:
      throw validationError("INVALID_STATUS", "Unsupported Telegram delivery status.");
  }
}
