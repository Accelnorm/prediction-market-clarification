// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { buildArtifactLinkHref } from "../src/reviewer-artifact-links.ts";

test("buildArtifactLinkHref converts ipfs artifact references to a browser-safe gateway URL", () => {
  assert.equal(
    buildArtifactLinkHref("ipfs://bafydetailartifact001"),
    "https://ipfs.io/ipfs/bafydetailartifact001"
  );
});

test("buildArtifactLinkHref keeps https artifact references unchanged", () => {
  assert.equal(
    buildArtifactLinkHref(
      "https://artifacts.example.test/ipfs/bafydetailartifact001"
    ),
    "https://artifacts.example.test/ipfs/bafydetailartifact001"
  );
});

test("buildArtifactLinkHref returns null when no artifact reference is available", () => {
  assert.equal(buildArtifactLinkHref(""), null);
  assert.equal(buildArtifactLinkHref(null), null);
});
