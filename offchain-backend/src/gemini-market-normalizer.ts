function extractRichTextText(value: any): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(extractRichTextText).filter(Boolean).join(" ").trim();
  }

  if (typeof value.value === "string") {
    return value.value;
  }

  if (Array.isArray(value.content)) {
    return value.content.map(extractRichTextText).filter(Boolean).join(" ").trim();
  }

  return "";
}

function normalizeNullableString(value: any) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value);
  return normalized === "" ? null : normalized;
}

function normalizeOptionalString(value: any) {
  const normalized = normalizeNullableString(value);
  return normalized === null ? undefined : normalized;
}

function normalizeOptionalNumberString(value: any) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const normalized = String(value);
  return normalized === "" ? undefined : normalized;
}

function normalizeArray(values: any) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value: any) => normalizeNullableString(value))
    .filter((value: any) => typeof value === "string");
}

function normalizeSubcategory(subcategory: any) {
  if (!subcategory || typeof subcategory !== "object") {
    return null;
  }

  return {
    id:
      subcategory.id === undefined || subcategory.id === null
        ? null
        : String(subcategory.id),
    slug: normalizeNullableString(subcategory.slug),
    name: normalizeNullableString(subcategory.name),
    path: normalizeArray(subcategory.path)
  };
}

function normalizeContract(contract: any) {
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

function buildGeminiMarketUrl(market: any) {
  if (typeof market?.url === "string" && market.url.trim() !== "") {
    return market.url;
  }

  if (typeof market?.slug === "string" && market.slug.trim() !== "") {
    return `https://www.gemini.com/prediction-markets/${market.slug}`;
  }

  return null;
}

export function normalizeGeminiMarket(market: any, lastSyncedAt: any) {
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
      ? market.contracts.map(normalizeContract)
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

export function mergeNormalizedMarket(existingMarket: any, normalizedMarket: any, refreshedAt: any) {
  return {
    ...existingMarket,
    ...normalizedMarket,
    lastSyncedAt: existingMarket.lastSyncedAt ?? normalizedMarket.lastSyncedAt,
    ...(refreshedAt ? { lastRefreshedAt: refreshedAt } : {})
  };
}

export function sameNormalizedMarketShape(left: any, right: any) {
  return JSON.stringify(left) === JSON.stringify(right);
}
