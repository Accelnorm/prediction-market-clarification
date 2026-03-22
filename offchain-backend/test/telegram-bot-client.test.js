import test from "node:test";
import assert from "node:assert/strict";

import {
  assertTelegramWebhookSecret,
  registerTelegramWebhook,
  sendTelegramMessage
} from "../src/telegram-bot-client.js";

test("assertTelegramWebhookSecret accepts the configured Telegram secret token", () => {
  assert.doesNotThrow(() => {
    assertTelegramWebhookSecret(
      {
        headers: {
          "x-telegram-bot-api-secret-token": "telegram-secret"
        }
      },
      "telegram-secret"
    );
  });
});

test("assertTelegramWebhookSecret rejects mismatched Telegram secret tokens", () => {
  assert.throws(
    () =>
      assertTelegramWebhookSecret(
        {
          headers: {
            "x-telegram-bot-api-secret-token": "wrong-secret"
          }
        },
        "telegram-secret"
      ),
    {
      code: "TELEGRAM_WEBHOOK_FORBIDDEN",
      statusCode: 403
    }
  );
});

test("sendTelegramMessage posts a message to the Telegram Bot API", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: {
            message_id: 8080
          }
        };
      }
    };
  };

  try {
    const result = await sendTelegramMessage({
      botToken: "telegram-token",
      chatId: "9001",
      text: "hello from test",
      apiBaseUrl: "https://telegram.test"
    });

    assert.deepEqual(result, {
      ok: true,
      messageId: 8080
    });
    assert.deepEqual(requests, [
      {
        url: "https://telegram.test/bottelegram-token/sendMessage",
        options: {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            chat_id: "9001",
            text: "hello from test"
          })
        }
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendTelegramMessage surfaces Telegram API failures as structured 502 errors", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    async json() {
      return {
        ok: false,
        description: "Forbidden: bot was blocked by the user"
      };
    }
  });

  try {
    await assert.rejects(
      () =>
        sendTelegramMessage({
          botToken: "telegram-token",
          chatId: "9001",
          text: "hello from test"
        }),
      {
        code: "TELEGRAM_DELIVERY_FAILED",
        statusCode: 502,
        message: "Forbidden: bot was blocked by the user"
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registerTelegramWebhook posts the webhook URL and secret to Telegram", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: true
        };
      }
    };
  };

  try {
    const result = await registerTelegramWebhook({
      botToken: "telegram-token",
      webhookUrl: "https://example.com/api/telegram/webhook",
      secretToken: "telegram-secret",
      apiBaseUrl: "https://telegram.test"
    });

    assert.deepEqual(result, {
      ok: true,
      webhookUrl: "https://example.com/api/telegram/webhook"
    });
    assert.deepEqual(requests, [
      {
        url: "https://telegram.test/bottelegram-token/setWebhook",
        options: {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            url: "https://example.com/api/telegram/webhook",
            secret_token: "telegram-secret"
          })
        }
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
