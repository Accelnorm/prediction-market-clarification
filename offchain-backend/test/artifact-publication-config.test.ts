import test from "node:test";
import assert from "node:assert/strict";

import { loadArtifactPublicationConfig } from "../src/artifact-publication-config.js";

test("artifact publication config defaults to disabled", () => {
  const config = loadArtifactPublicationConfig({});

  assert.deepEqual(config, {
    provider: "disabled",
    enabled: false,
    ipfsApiUrl: null,
    ipfsGatewayBaseUrl: null,
    ipfsAuthToken: null
  });
});

test("artifact publication config loads IPFS settings when enabled", () => {
  const config = loadArtifactPublicationConfig({
    ARTIFACT_PUBLICATION_PROVIDER: "ipfs",
    IPFS_API_URL: "https://ipfs.example",
    IPFS_GATEWAY_BASE_URL: "https://gateway.example",
    IPFS_AUTH_TOKEN: "token"
  });

  assert.deepEqual(config, {
    provider: "ipfs",
    enabled: true,
    ipfsApiUrl: "https://ipfs.example",
    ipfsGatewayBaseUrl: "https://gateway.example",
    ipfsAuthToken: "token"
  });
});
