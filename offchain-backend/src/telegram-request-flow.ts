const MARKET_ID_PATTERN = /^gm[a-z0-9_-]*[a-z0-9]$/i;
const CLARIFY_COMMAND_PATTERN = /^\/clarify(?:@\w+)?\s+/i;

function invalidTelegramPayload(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "INVALID_TELEGRAM_UPDATE" });
}

function validationError(code, message) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function parseClarifyCommand(text) {
  if (typeof text !== "string" || !CLARIFY_COMMAND_PATTERN.test(text)) {
    throw invalidTelegramPayload(
      "Telegram update must include a /clarify command with a market id and question."
    );
  }

  const withoutCommand = text.replace(CLARIFY_COMMAND_PATTERN, "").trim();

  if (!withoutCommand) {
    throw validationError(
      "INVALID_MARKET_ID",
      "Market identifier must use Gemini market id format, for example gm_eth_above_5000."
    );
  }

  const firstSpaceIndex = withoutCommand.search(/\s/);
  const marketId =
    firstSpaceIndex === -1 ? withoutCommand : withoutCommand.slice(0, firstSpaceIndex);
  const question =
    firstSpaceIndex === -1 ? "" : withoutCommand.slice(firstSpaceIndex).trim();

  if (!MARKET_ID_PATTERN.test(marketId)) {
    throw validationError(
      "INVALID_MARKET_ID",
      "Market identifier must use Gemini market id format, for example gm_eth_above_5000."
    );
  }

  if (!question) {
    throw validationError("INVALID_QUESTION", "Clarification question cannot be empty.");
  }

  return {
    marketId,
    question
  };
}

function defaultCreateRequestId(update) {
  return `clr_tg_${String(update.update_id ?? Date.now())}`;
}

export async function createTelegramClarificationRequest({
  update,
  repository,
  now = () => new Date(),
  createRequestId = defaultCreateRequestId
}) {
  if (!update?.message?.chat?.id || !update?.message?.from?.id) {
    throw invalidTelegramPayload("Telegram update must include both chat and sender identifiers.");
  }

  const { marketId, question } = parseClarifyCommand(update.message.text);
  const createdAt = now().toISOString();
  const request = {
    requestId: String(createRequestId(update)),
    source: "telegram",
    status: "pending",
    marketId,
    question,
    telegramChatId: String(update.message.chat.id),
    telegramUserId: String(update.message.from.id),
    telegramUsername: update.message.from.username
      ? String(update.message.from.username)
      : null,
    createdAt
  };

  await repository.create(request);

  return {
    requestId: request.requestId,
    status: request.status
  };
}
