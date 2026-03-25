import type { ArtifactInput } from "./types.js";

function buildIpfsGatewayUrl(baseUrl: string | null, cid: string) {
  if (!baseUrl) {
    return null;
  }

  return `${baseUrl.replace(/\/$/, "")}/ipfs/${encodeURIComponent(cid)}`;
}

function parseIpfsAddResponseBody(body: unknown) {
  const normalized = String(body ?? "").trim();

  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return JSON.parse(lines.at(-1) as string);
}

function buildPublicationSourcePayload(artifact: ArtifactInput) {
  return {
    clarificationId: artifact.clarificationId ?? null,
    eventId: artifact.eventId ?? null,
    marketText: artifact.marketText ?? null,
    suggestedEditedMarketText: artifact.suggestedEditedMarketText ?? null,
    clarificationNote: artifact.clarificationNote ?? null,
    generatedAtUtc: artifact.generatedAtUtc ?? null
  };
}

export function createDisabledArtifactPublisher() {
  return {
    provider: "disabled",
    async publishArtifact() {
      return {
        publicationProvider: "disabled",
        publicationStatus: "disabled",
        publishedCid: null,
        publishedUrl: null,
        publishedUri: null,
        publishedAt: null,
        publicationError: null
      };
    }
  };
}

export type IpfsArtifactPublisherOptions = {
  ipfsApiUrl: string | null;
  ipfsGatewayBaseUrl?: string | null;
  ipfsAuthToken?: string | null;
  fetchImpl?: typeof fetch;
};

export function createIpfsArtifactPublisher({
  ipfsApiUrl,
  ipfsGatewayBaseUrl = null,
  ipfsAuthToken = null,
  fetchImpl = fetch
}: IpfsArtifactPublisherOptions) {
  return {
    provider: "ipfs",
    async publishArtifact(artifact: ArtifactInput) {
      const formData = new FormData();
      const body = JSON.stringify(buildPublicationSourcePayload(artifact), null, 2);
      formData.set(
        "file",
        new Blob([body], { type: "application/json" }),
        `${artifact.clarificationId ?? artifact.eventId ?? "clarification-artifact"}.json`
      );

      const response = await fetchImpl(`${(ipfsApiUrl ?? "").replace(/\/$/, "")}/api/v0/add?pin=true`, {
        method: "POST",
        headers: {
          ...(ipfsAuthToken ? { authorization: `Bearer ${ipfsAuthToken}` } : {})
        },
        body: formData
      });

      const responseBody = await response.text();
      const parsed = parseIpfsAddResponseBody(responseBody);

      if (!response.ok || !parsed?.Hash) {
        const error = Object.assign(new Error("IPFS artifact publication failed."), {
          code: "ARTIFACT_PUBLICATION_FAILED",
          statusCode: 502,
          details: parsed ?? responseBody
        });
        throw error;
      }

      const publishedAt = new Date().toISOString();
      const publishedCid = parsed.Hash;
      const publishedUri = `ipfs://${publishedCid}`;

      return {
        publicationProvider: "ipfs",
        publicationStatus: "published",
        publishedCid,
        publishedUrl: buildIpfsGatewayUrl(ipfsGatewayBaseUrl, publishedCid) ?? publishedUri,
        publishedUri,
        publishedAt,
        publicationError: null
      };
    }
  };
}
