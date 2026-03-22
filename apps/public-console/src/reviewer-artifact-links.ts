export function buildArtifactLinkHref(artifactUrl: string | null | undefined) {
  if (typeof artifactUrl !== "string" || artifactUrl.trim() === "") {
    return null;
  }

  if (artifactUrl.startsWith("ipfs://")) {
    const cid = artifactUrl.slice("ipfs://".length).trim();

    return cid ? `https://ipfs.io/ipfs/${cid}` : null;
  }

  return artifactUrl;
}
