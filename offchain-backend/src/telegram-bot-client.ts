function validationError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function assertTelegramWebhookSecret(request, expectedSecret) {
  if (!expectedSecret) {
    return;
  }

  const actualSecret = request.headers["x-telegram-bot-api-secret-token"];

  if (actualSecret === expectedSecret) {
    return;
  }

  throw validationError(
    "TELEGRAM_WEBHOOK_FORBIDDEN",
    "Telegram webhook secret token is invalid.",
    403
  );
}

export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  apiBaseUrl = "https://api.telegram.org"
}) {
  if (!botToken) {
    throw validationError(
      "TELEGRAM_BOT_TOKEN_REQUIRED",
      "Telegram bot token is required for outbound delivery.",
      500
    );
  }

  const response = await fetch(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  let payload: any = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.ok === false) {
    const description =
      typeof payload?.description === "string" && payload.description.trim() !== ""
        ? payload.description
        : "Telegram Bot API request failed.";

    throw validationError("TELEGRAM_DELIVERY_FAILED", description, 502);
  }

  return {
    ok: true,
    messageId: payload?.result?.message_id ?? null
  };
}

export async function registerTelegramWebhook({
  botToken,
  webhookUrl,
  secretToken = null as string | null,
  apiBaseUrl = "https://api.telegram.org"
}) {
  if (!webhookUrl) {
    throw validationError(
      "TELEGRAM_WEBHOOK_URL_REQUIRED",
      "Telegram webhook URL is required for webhook registration.",
      500
    );
  }

  if (!botToken) {
    throw validationError(
      "TELEGRAM_BOT_TOKEN_REQUIRED",
      "Telegram bot token is required for webhook registration.",
      500
    );
  }

  const response = await fetch(`${apiBaseUrl}/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      url: webhookUrl,
      ...(secretToken ? { secret_token: secretToken } : {})
    })
  });
  const payload = await readJsonResponse(response);

  if (!response.ok || payload?.ok === false) {
    const description =
      typeof payload?.description === "string" && payload.description.trim() !== ""
        ? payload.description
        : "Telegram webhook registration failed.";

    throw validationError("TELEGRAM_WEBHOOK_REGISTRATION_FAILED", description, 502);
  }

  return {
    ok: true,
    webhookUrl
  };
}
