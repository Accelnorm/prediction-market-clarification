// payai facilitator /verify validates network against the x402 SDK's NetworkSchema,
// which uses short names ("solana", "solana-devnet"), not CAIP-2 identifiers.
const SOLANA_MAINNET_NETWORK = "solana";
const SOLANA_DEVNET_NETWORK = "solana-devnet";
const SOLANA_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveFacilitatorAuthConfig(env: NodeJS.ProcessEnv) {
  const payaiApiKeyId = normalizeString(env.PAYAI_API_KEY_ID) || null;
  const payaiApiKeySecret = normalizeString(env.PAYAI_API_KEY_SECRET) || null;
  const facilitatorAuthToken = normalizeString(env.X402_FACILITATOR_AUTH_TOKEN) || null;

  return {
    payaiApiKeyId,
    payaiApiKeySecret,
    facilitatorAuthToken
  };
}

function resolveNetworkIdentifier(value: unknown): string {
  const normalized = normalizeString(value).toLowerCase();

  if (!normalized || normalized === "solana:devnet" || normalized === "devnet" || normalized === "solana-devnet") {
    return SOLANA_DEVNET_NETWORK;
  }

  if (
    normalized === "solana:mainnet" ||
    normalized === "solana" ||
    normalized === "mainnet" ||
    normalized === "mainnet-beta"
  ) {
    return SOLANA_MAINNET_NETWORK;
  }

  return normalizeString(value);
}

function resolveCluster(network: string): "mainnet" | "devnet" {
  if (network === SOLANA_MAINNET_NETWORK) {
    return "mainnet";
  }

  return "devnet";
}

function resolveDefaultMint(network: string): string {
  return network === SOLANA_MAINNET_NETWORK
    ? SOLANA_MAINNET_USDC_MINT
    : SOLANA_DEVNET_USDC_MINT;
}

export function loadX402PaymentConfig(env: NodeJS.ProcessEnv = process.env) {
  const network = resolveNetworkIdentifier(env.X402_NETWORK);
  const cluster = resolveCluster(network);
  const authConfig = resolveFacilitatorAuthConfig(env);

  return {
    x402Version: Number.parseInt(env.X402_VERSION ?? "2", 10),
    scheme: normalizeString(env.X402_SCHEME) || "exact",
    priceUsd: normalizeString(env.X402_PRICE_USD) || "1.00",
    maxAmountRequired:
      normalizeString(env.X402_MAX_AMOUNT_REQUIRED) || "1000000",
    assetSymbol: normalizeString(env.X402_ASSET_SYMBOL) || "USDC",
    network,
    cluster,
    mintAddress: normalizeString(env.X402_MINT_ADDRESS) || resolveDefaultMint(network),
    recipientAddress:
      normalizeString(env.X402_RECIPIENT_ADDRESS) ||
      "11111111111111111111111111111111",
    maxTimeoutSeconds: Number.parseInt(env.X402_MAX_TIMEOUT_SECONDS ?? "300", 10),
    facilitatorUrl:
      normalizeString(env.X402_FACILITATOR_URL) ||
      "https://facilitator.payai.network",
    feePayer: normalizeString(env.X402_FEE_PAYER) || null,
    facilitatorAuthToken: authConfig.facilitatorAuthToken,
    payaiApiKeyId: authConfig.payaiApiKeyId,
    payaiApiKeySecret: authConfig.payaiApiKeySecret,
    verificationSource:
      normalizeString(env.X402_VERIFICATION_SOURCE) || "payai_facilitator",
    resourceBaseUrl: normalizeString(env.PUBLIC_API_BASE_URL) || null
  };
}
