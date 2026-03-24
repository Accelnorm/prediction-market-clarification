function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function loadArtifactPublicationConfig(env: NodeJS.ProcessEnv = process.env) {
  const provider = normalizeString(env.ARTIFACT_PUBLICATION_PROVIDER).toLowerCase() || "disabled";

  return {
    provider: provider === "ipfs" ? "ipfs" : "disabled",
    enabled: provider === "ipfs",
    ipfsApiUrl: normalizeString(env.IPFS_API_URL) || null,
    ipfsGatewayBaseUrl: normalizeString(env.IPFS_GATEWAY_BASE_URL) || null,
    ipfsAuthToken: normalizeString(env.IPFS_AUTH_TOKEN) || null
  };
}
