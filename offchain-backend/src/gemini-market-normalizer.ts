import type { MarketRecord, ContractRecord } from "./types.js";

type RichTextNode = {
  value?: string;
  content?: unknown[];
};

function extractRichTextText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(extractRichTextText).filter(Boolean).join(" ").trim();
  }

  const node = value as RichTextNode;

  if (typeof node.value === "string") {
    return node.value;
  }

  if (Array.isArray(node.content)) {
    return node.content.map(extractRichTextText).filter(Boolean).join(" ").trim();
  }

  return "";
}

function normalizeNullableString(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value);
  return normalized === "" ? null : normalized;
}

function normalizeOptionalString(value: unknown) {
  const normalized = normalizeNullableString(value);
  return normalized === null ? undefined : normalized;
}

function normalizeOptionalNumberString(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const normalized = String(value);
  return normalized === "" ? undefined : normalized;
}

function normalizeArray(values: unknown) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value: unknown) => normalizeNullableString(value))
    .filter((value: string | null): value is string => typeof value === "string");
}

type SourceSubcategory = {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  path?: unknown;
};

function normalizeSubcategory(subcategory: unknown) {
  if (!subcategory || typeof subcategory !== "object") {
    return null;
  }

  const sub = subcategory as SourceSubcategory;

  return {
    id:
      sub.id === undefined || sub.id === null
        ? null
        : String(sub.id),
    slug: normalizeNullableString(sub.slug),
    name: normalizeNullableString(sub.name),
    path: normalizeArray(sub.path)
  };
}

type SourceContract = {
  id?: unknown;
  label?: unknown;
  abbreviatedName?: unknown;
  description?: unknown;
  status?: unknown;
  ticker?: unknown;
  instrumentSymbol?: unknown;
  marketState?: unknown;
  effectiveDate?: unknown;
  expiryDate?: unknown;
  termsAndConditionsUrl?: unknown;
  prices?: unknown;
  sortOrder?: unknown;
};

function normalizeContract(contract: SourceContract): ContractRecord {
  return {
    id: normalizeNullableString(contract?.id),
    label: normalizeNullableString(contract?.label),
    abbreviatedName: normalizeNullableString(contract?.abbreviatedName),
    description: extractRichTextText(contract?.description),
    status: normalizeNullableString(contract?.status),
    ticker: normalizeNullableString(contract?.ticker),
    instrumentSymbol: normalizeNullableString(contract?.instrumentSymbol),
    marketState: normalizeNullableString(contract?.marketState),
    effectiveDate: normalizeNullableString(contract?.effectiveDate),
    expiryDate: normalizeNullableString(contract?.expiryDate),
    termsAndConditionsUrl: normalizeNullableString(contract?.termsAndConditionsUrl),
    prices:
      contract?.prices && typeof contract.prices === "object"
        ? JSON.parse(JSON.stringify(contract.prices))
        : null,
    sortOrder:
      contract?.sortOrder === undefined || contract?.sortOrder === null
        ? null
        : Number(contract.sortOrder)
  };
}

type SourceMarket = {
  id?: unknown;
  ticker?: unknown;
  title?: unknown;
  description?: unknown;
  resolution?: unknown;
  resolutionText?: unknown;
  closesAt?: unknown;
  endTime?: unknown;
  expiryDate?: unknown;
  slug?: unknown;
  url?: unknown;
  category?: unknown;
  subcategory?: unknown;
  tags?: unknown;
  status?: unknown;
  createdAt?: unknown;
  effectiveDate?: unknown;
  startTime?: unknown;
  resolvedAt?: unknown;
  termsLink?: unknown;
  contracts?: unknown[];
  volume?: unknown;
  liquidity?: unknown;
  activitySignal?: unknown;
};

function buildGeminiMarketUrl(market: SourceMarket) {
  if (typeof market?.url === "string" && market.url.trim() !== "") {
    return market.url;
  }

  if (typeof market?.slug === "string" && market.slug.trim() !== "") {
    return `https://www.gemini.com/prediction-markets/${market.slug}`;
  }

  return null;
}

export function normalizeGeminiMarket(market: SourceMarket, lastSyncedAt: string): MarketRecord {
  const description = extractRichTextText(market?.description);
  const resolutionText = String(
    market?.resolution ?? market?.resolutionText ?? description ?? market?.title ?? ""
  );
  const closesAt = String(market?.closesAt ?? market?.endTime ?? market?.expiryDate ?? "");

  return {
    marketId: String(market?.id ?? ""),
    ticker: normalizeNullableString(market?.ticker),
    title: String(market?.title ?? ""),
    description,
    resolution: resolutionText,
    resolutionText,
    closesAt,
    endTime: closesAt,
    slug: normalizeNullableString(market?.slug),
    url: buildGeminiMarketUrl(market),
    category: normalizeNullableString(market?.category),
    subcategory: normalizeSubcategory(market?.subcategory),
    tags: normalizeArray(market?.tags),
    status: normalizeNullableString(market?.status),
    createdAt: normalizeNullableString(market?.createdAt),
    effectiveDate: normalizeNullableString(market?.effectiveDate ?? market?.startTime),
    expiryDate: normalizeNullableString(market?.expiryDate ?? market?.closesAt),
    resolvedAt: normalizeNullableString(market?.resolvedAt),
    termsLink: normalizeNullableString(market?.termsLink),
    contracts: Array.isArray(market?.contracts)
      ? market.contracts.map((c) => normalizeContract(c as SourceContract))
      : [],
    ...(normalizeOptionalNumberString(market?.volume)
      ? { volumeUsd: normalizeOptionalNumberString(market?.volume) }
      : {}),
    ...(normalizeOptionalNumberString(market?.liquidity)
      ? { liquidityUsd: normalizeOptionalNumberString(market?.liquidity) }
      : {}),
    ...(normalizeOptionalString(market?.activitySignal)
      ? { activitySignal: normalizeOptionalString(market?.activitySignal) }
      : {}),
    lastSyncedAt
  };
}

export function mergeNormalizedMarket(existingMarket: MarketRecord, normalizedMarket: MarketRecord, refreshedAt: string | null) {
  return {
    ...existingMarket,
    ...normalizedMarket,
    lastSyncedAt: existingMarket.lastSyncedAt ?? normalizedMarket.lastSyncedAt,
    ...(refreshedAt ? { lastRefreshedAt: refreshedAt } : {})
  };
}

export function sameNormalizedMarketShape(left: MarketRecord, right: MarketRecord) {
  return JSON.stringify(left) === JSON.stringify(right);
}
