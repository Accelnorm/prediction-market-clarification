import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { requests: [] };

export class FileClarificationRequestRepository {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        requests: Array.isArray(parsed.requests) ? parsed.requests : []
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(requests) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ requests }, null, 2) + "\n", "utf8");
  }

  async create(request) {
    const store = await this.load();
    const requests = [
      ...store.requests,
      {
        ...request,
        updatedAt: request.updatedAt ?? request.createdAt,
        clarificationId: request.clarificationId ?? null,
        summary: request.summary ?? null,
        errorMessage: request.errorMessage ?? null,
        retryable: request.retryable ?? false,
        llmOutput: request.llmOutput ?? null,
        llmTrace: request.llmTrace ?? null,
        artifactCid: request.artifactCid ?? null,
        artifactUrl: request.artifactUrl ?? null,
        statusHistory: Array.isArray(request.statusHistory)
          ? request.statusHistory
          : [{ status: request.status, timestamp: request.updatedAt ?? request.createdAt }]
      }
    ];
    await this.save(requests);
    return requests.at(-1);
  }

  async findByTelegramIdentifiers({ telegramChatId, telegramUserId }) {
    const store = await this.load();

    return store.requests.filter((request) => {
      if (telegramChatId && request.telegramChatId !== telegramChatId) {
        return false;
      }

      if (telegramUserId && request.telegramUserId !== telegramUserId) {
        return false;
      }

      return true;
    });
  }

  async findByRequestId(requestId) {
    const store = await this.load();
    return store.requests.find((request) => request.requestId === requestId) ?? null;
  }

  async findByClarificationId(clarificationId) {
    const store = await this.load();
    return (
      store.requests.find((request) => request.clarificationId === clarificationId) ?? null
    );
  }

  async findByPaymentProof(paymentProof) {
    const store = await this.load();
    return (
      store.requests.find(
        (request) => typeof request.paymentProof === "string" && request.paymentProof === paymentProof
      ) ?? null
    );
  }

  async updateStatus(requestId, updates) {
    const store = await this.load();
    const requestIndex = store.requests.findIndex((request) => request.requestId === requestId);

    if (requestIndex === -1) {
      return null;
    }

    const existingRequest = store.requests[requestIndex];
    const nextRequest = {
      ...existingRequest,
      status: updates.status,
      updatedAt: updates.updatedAt,
      clarificationId: updates.clarificationId ?? existingRequest.clarificationId ?? null,
      summary: updates.summary ?? existingRequest.summary ?? null,
      errorMessage: updates.errorMessage ?? existingRequest.errorMessage ?? null,
      statusHistory: [
        ...(Array.isArray(existingRequest.statusHistory) ? existingRequest.statusHistory : []),
        {
          status: updates.status,
          timestamp: updates.updatedAt
        }
      ]
    };
    const requests = [...store.requests];
    requests[requestIndex] = nextRequest;
    await this.save(requests);
    return nextRequest;
  }

  async updateByClarificationId(clarificationId, updates) {
    const store = await this.load();
    const requestIndex = store.requests.findIndex(
      (request) => request.clarificationId === clarificationId
    );

    if (requestIndex === -1) {
      return null;
    }

    const existingRequest = store.requests[requestIndex];
    const nextStatus = updates.status ?? existingRequest.status;
    const nextUpdatedAt = updates.updatedAt ?? existingRequest.updatedAt;
    const shouldAppendStatusHistory =
      typeof updates.status === "string" && updates.status !== existingRequest.status;
    const nextRequest = {
      ...existingRequest,
      ...updates,
      status: nextStatus,
      updatedAt: nextUpdatedAt,
      errorMessage:
        Object.prototype.hasOwnProperty.call(updates, "errorMessage")
          ? updates.errorMessage
          : existingRequest.errorMessage ?? null,
      retryable:
        Object.prototype.hasOwnProperty.call(updates, "retryable")
          ? updates.retryable
          : existingRequest.retryable ?? false,
      llmOutput:
        Object.prototype.hasOwnProperty.call(updates, "llmOutput")
          ? updates.llmOutput
          : existingRequest.llmOutput ?? null,
      llmTrace:
        Object.prototype.hasOwnProperty.call(updates, "llmTrace")
          ? updates.llmTrace
          : existingRequest.llmTrace ?? null,
      artifactCid:
        Object.prototype.hasOwnProperty.call(updates, "artifactCid")
          ? updates.artifactCid
          : existingRequest.artifactCid ?? null,
      artifactUrl:
        Object.prototype.hasOwnProperty.call(updates, "artifactUrl")
          ? updates.artifactUrl
          : existingRequest.artifactUrl ?? null,
      statusHistory: shouldAppendStatusHistory
        ? [
            ...(Array.isArray(existingRequest.statusHistory) ? existingRequest.statusHistory : []),
            {
              status: updates.status,
              timestamp: nextUpdatedAt
            }
          ]
        : existingRequest.statusHistory
    };
    const requests = [...store.requests];
    requests[requestIndex] = nextRequest;
    await this.save(requests);
    return nextRequest;
  }
}
