import { useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { buildArtifactLinkHref } from "./reviewer-artifact-links";

type ReviewerQueueFilter = {
  key: string;
  label: string;
  count: number;
};

type ReviewerSurface = "active" | "prelaunch";

type ReviewerMarketContract = {
  id: string | null;
  label: string | null;
  abbreviatedName: string | null;
  description: string | null;
  status: string | null;
  ticker: string | null;
  instrumentSymbol: string | null;
  marketState: string | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  termsAndConditionsUrl: string | null;
  prices: Record<string, unknown> | null;
  sortOrder: number | null;
};

type ReviewerMarketPayload = {
  marketId: string | null;
  ticker?: string;
  title: string | null;
  description?: string;
  resolutionText: string | null;
  endTime: string | null;
  slug: string | null;
  url: string | null;
  category?: string;
  subcategory?: {
    id: string | null;
    slug: string | null;
    name: string | null;
    path: string[];
  } | null;
  tags?: string[];
  status?: string;
  effectiveDate?: string;
  expiryDate?: string;
  resolvedAt?: string;
  termsLink?: string;
  contracts?: ReviewerMarketContract[];
};

type ReviewerQueueItem = {
  eventId: string;
  latestClarificationId: string | null;
  marketTitle: string;
  endTime: string;
  ambiguityScore: number | null;
  fundingProgress: {
    raisedAmount: string;
    targetAmount: string;
    contributorCount: number;
    fundingState: string;
  };
  reviewWindow: {
    review_window_secs: number;
    review_window_reason: string;
    time_to_end_bucket: string;
    activity_signal: string;
    ambiguity_score: number;
  };
  voteStatus: string;
  queueStates: string[];
};

type ReviewerQueueResponse = {
  ok: true;
  activeFilter?: string;
  filters: ReviewerQueueFilter[];
  queue: ReviewerQueueItem[];
};

type ReviewerClarificationDetail = {
  clarificationId: string;
  status: string;
  eventId: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  llmOutput: {
    verdict: string;
    llm_status: string;
    reasoning: string;
    cited_clause: string;
    ambiguity_score: number;
    ambiguity_summary: string;
    suggested_market_text: string;
    suggested_note: string;
  } | null;
  llmTrace: {
    promptTemplateVersion: string;
    modelId: string;
    requestedAt: string;
    processingVersion: string;
  } | null;
  market: ReviewerMarketPayload;
  funding: {
    raisedAmount: string;
    targetAmount: string;
    contributorCount: number;
    fundingState: string;
    history: Array<{
      contributor: string;
      amount: string;
      timestamp: string;
      reference: string | null;
    }>;
  };
  vote: {
    status: string;
    label: string;
    placeholder: boolean;
    summary: string;
    updatedAt: string;
  };
  artifact?: {
    cid: string;
    url: string;
  };
  review_window_secs: number;
  review_window_reason: string;
  time_to_end_bucket: string;
  activity_signal: string;
  ambiguity_score: number;
};

type ReviewerClarificationDetailResponse = {
  ok: true;
  clarification: ReviewerClarificationDetail;
};

type PrelaunchQueueItem = {
  eventId: string;
  marketTitle: string;
  ticker: string | null;
  category: string | null;
  status: string | null;
  startsAt: string | null;
  endTime: string;
  ambiguityScore: number | null;
  needsScan: boolean;
  latestScanId: string | null;
  reviewWindow: {
    review_window_secs: number;
    review_window_reason: string;
    time_to_end_bucket: string;
    activity_signal: string;
    ambiguity_score: number;
  };
  contracts: ReviewerMarketContract[];
};

type PrelaunchQueueResponse = {
  ok: true;
  queue: PrelaunchQueueItem[];
};

type PrelaunchMarketDetailResponse = {
  ok: true;
  market: ReviewerMarketPayload;
  latestScan: {
    scanId: string;
    eventId: string;
    createdAt: string;
    ambiguityScore: number | null;
    recommendation: string;
    reviewWindow: {
      review_window_secs: number;
      review_window_reason: string;
      time_to_end_bucket: string;
      activity_signal: string;
      ambiguity_score: number;
    };
  } | null;
};

type ReviewerArtifactRecord = {
  clarificationId: string;
  eventId: string;
  marketText: string;
  suggestedEditedMarketText: string;
  clarificationNote: string;
  generatedAtUtc: string;
  cid: string;
  url: string;
};

const REVIEWER_SESSION_STORAGE_KEY = "gemini-reviewer-session";

function loadReviewerSession() {
  if (typeof window === "undefined") {
    return {
      apiBaseUrl: "",
      reviewerToken: "",
    };
  }

  try {
    const raw = window.localStorage.getItem(REVIEWER_SESSION_STORAGE_KEY);

    if (!raw) {
      return {
        apiBaseUrl: "",
        reviewerToken: "",
      };
    }

    const parsed = JSON.parse(raw);

    return {
      apiBaseUrl:
        typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : "",
      reviewerToken:
        typeof parsed.reviewerToken === "string" ? parsed.reviewerToken : "",
    };
  } catch {
    return {
      apiBaseUrl: "",
      reviewerToken: "",
    };
  }
}

function saveReviewerSession(session: {
  apiBaseUrl: string;
  reviewerToken: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    REVIEWER_SESSION_STORAGE_KEY,
    JSON.stringify(session)
  );
}

function clearReviewerSession() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(REVIEWER_SESSION_STORAGE_KEY);
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function formatQueueStateLabel(state: string) {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAmbiguityScore(score: number | null) {
  if (typeof score !== "number") {
    return "Not scanned";
  }

  return score.toFixed(2);
}

function formatCurrency(amount: string) {
  return `${amount} USDC`;
}

function formatOptionalTimestamp(timestamp?: string | null) {
  return timestamp ? formatTimestamp(timestamp) : "Unavailable";
}

function formatContractPriceSummary(prices: Record<string, unknown> | null) {
  if (!prices || typeof prices !== "object") {
    return "No price snapshot";
  }

  const priceEntries = Object.entries(prices)
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 3)
    .map(([key, value]) =>
      typeof value === "object" ? `${key}: ${JSON.stringify(value)}` : `${key}: ${value}`
    );

  return priceEntries.length > 0 ? priceEntries.join(" • ") : "No price snapshot";
}

function ReviewerConsole() {
  const initialSession = useMemo(() => loadReviewerSession(), []);
  const [draftApiBaseUrl, setDraftApiBaseUrl] = useState(
    initialSession.apiBaseUrl
  );
  const [draftReviewerToken, setDraftReviewerToken] = useState(
    initialSession.reviewerToken
  );
  const [session, setSession] = useState(initialSession);
  const [reviewerSurface, setReviewerSurface] =
    useState<ReviewerSurface>("active");
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [queueResponse, setQueueResponse] =
    useState<ReviewerQueueResponse | null>(null);
  const [prelaunchQueueResponse, setPrelaunchQueueResponse] =
    useState<PrelaunchQueueResponse | null>(null);
  const [selectedClarificationId, setSelectedClarificationId] = useState<
    string | null
  >(null);
  const [selectedPrelaunchEventId, setSelectedPrelaunchEventId] = useState<
    string | null
  >(null);
  const [detailResponse, setDetailResponse] =
    useState<ReviewerClarificationDetailResponse | null>(null);
  const [prelaunchDetailResponse, setPrelaunchDetailResponse] =
    useState<PrelaunchMarketDetailResponse | null>(null);
  const [artifactPreview, setArtifactPreview] =
    useState<ReviewerArtifactRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [prelaunchErrorMessage, setPrelaunchErrorMessage] = useState<
    string | null
  >(null);
  const [detailErrorMessage, setDetailErrorMessage] = useState<string | null>(
    null
  );
  const [prelaunchDetailErrorMessage, setPrelaunchDetailErrorMessage] =
    useState<string | null>(null);
  const [artifactPreviewError, setArtifactPreviewError] = useState<
    string | null
  >(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPrelaunchLoading, setIsPrelaunchLoading] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isPrelaunchDetailLoading, setIsPrelaunchDetailLoading] =
    useState(false);
  const [isArtifactPreviewLoading, setIsArtifactPreviewLoading] =
    useState(false);
  const [prelaunchScanTargetId, setPrelaunchScanTargetId] = useState<
    string | null
  >(null);
  const [isPrelaunchScanAllRunning, setIsPrelaunchScanAllRunning] =
    useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (
      reviewerSurface !== "active" ||
      !session.apiBaseUrl ||
      !session.reviewerToken
    ) {
      setQueueResponse(null);
      return;
    }

    let cancelled = false;

    async function loadQueue() {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const endpoint = new URL("/api/reviewer/queue", session.apiBaseUrl);

        if (activeFilter !== "all") {
          endpoint.searchParams.set("filter", activeFilter);
        }

        const response = await fetch(endpoint, {
          headers: {
            "x-reviewer-token": session.reviewerToken,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload?.error?.message ??
              "Reviewer queue could not be loaded with the current session."
          );
        }

        if (!cancelled) {
          setQueueResponse(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setQueueResponse(null);
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Reviewer queue could not be loaded with the current session."
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadQueue();

    return () => {
      cancelled = true;
    };
  }, [activeFilter, refreshNonce, reviewerSurface, session]);

  useEffect(() => {
    if (
      reviewerSurface !== "prelaunch" ||
      !session.apiBaseUrl ||
      !session.reviewerToken
    ) {
      setPrelaunchQueueResponse(null);
      return;
    }

    let cancelled = false;

    async function loadPrelaunchQueue() {
      setIsPrelaunchLoading(true);
      setPrelaunchErrorMessage(null);

      try {
        const endpoint = new URL("/api/reviewer/prelaunch/queue", session.apiBaseUrl);
        const response = await fetch(endpoint, {
          headers: {
            "x-reviewer-token": session.reviewerToken,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload?.error?.message ??
              "Prelaunch reviewer queue could not be loaded with the current session."
          );
        }

        if (!cancelled) {
          setPrelaunchQueueResponse(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setPrelaunchQueueResponse(null);
          setPrelaunchErrorMessage(
            error instanceof Error
              ? error.message
              : "Prelaunch reviewer queue could not be loaded with the current session."
          );
        }
      } finally {
        if (!cancelled) {
          setIsPrelaunchLoading(false);
        }
      }
    }

    void loadPrelaunchQueue();

    return () => {
      cancelled = true;
    };
  }, [refreshNonce, reviewerSurface, session]);

  useEffect(() => {
    if (
      reviewerSurface !== "active" ||
      !session.apiBaseUrl ||
      !session.reviewerToken ||
      !selectedClarificationId
    ) {
      setDetailResponse(null);
      setDetailErrorMessage(null);
      setIsDetailLoading(false);
      return;
    }

    const clarificationId = selectedClarificationId;
    let cancelled = false;

    async function loadDetail() {
      setIsDetailLoading(true);
      setDetailErrorMessage(null);

      try {
        const endpoint = new URL(
          `/api/reviewer/clarifications/${encodeURIComponent(clarificationId)}`,
          session.apiBaseUrl
        );
        const response = await fetch(endpoint, {
          headers: {
            "x-reviewer-token": session.reviewerToken,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload?.error?.message ??
              "Reviewer detail could not be loaded with the current session."
          );
        }

        if (!cancelled) {
          setDetailResponse(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setDetailResponse(null);
          setDetailErrorMessage(
            error instanceof Error
              ? error.message
              : "Reviewer detail could not be loaded with the current session."
          );
        }
      } finally {
        if (!cancelled) {
          setIsDetailLoading(false);
        }
      }
    }

    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [reviewerSurface, selectedClarificationId, session]);

  useEffect(() => {
    if (
      reviewerSurface !== "prelaunch" ||
      !session.apiBaseUrl ||
      !session.reviewerToken ||
      !selectedPrelaunchEventId
    ) {
      setPrelaunchDetailResponse(null);
      setPrelaunchDetailErrorMessage(null);
      setIsPrelaunchDetailLoading(false);
      return;
    }

    const eventId = selectedPrelaunchEventId;
    let cancelled = false;

    async function loadPrelaunchDetail() {
      setIsPrelaunchDetailLoading(true);
      setPrelaunchDetailErrorMessage(null);

      try {
        const endpoint = new URL(
          `/api/reviewer/prelaunch/markets/${encodeURIComponent(eventId)}`,
          session.apiBaseUrl
        );
        const response = await fetch(endpoint, {
          headers: {
            "x-reviewer-token": session.reviewerToken,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload?.error?.message ??
              "Prelaunch market detail could not be loaded with the current session."
          );
        }

        if (!cancelled) {
          setPrelaunchDetailResponse(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setPrelaunchDetailResponse(null);
          setPrelaunchDetailErrorMessage(
            error instanceof Error
              ? error.message
              : "Prelaunch market detail could not be loaded with the current session."
          );
        }
      } finally {
        if (!cancelled) {
          setIsPrelaunchDetailLoading(false);
        }
      }
    }

    void loadPrelaunchDetail();

    return () => {
      cancelled = true;
    };
  }, [refreshNonce, reviewerSurface, selectedPrelaunchEventId, session]);

  const filters = queueResponse?.filters ?? [];
  const detail = detailResponse?.clarification ?? null;
  const prelaunchQueue = prelaunchQueueResponse?.queue ?? [];
  const prelaunchDetail = prelaunchDetailResponse?.market ?? null;
  const prelaunchLatestScan = prelaunchDetailResponse?.latestScan ?? null;
  const selectedArtifactCid = detail?.artifact?.cid ?? null;
  const selectedArtifactHref = buildArtifactLinkHref(detail?.artifact?.url);

  useEffect(() => {
    if (!session.apiBaseUrl || !session.reviewerToken || !selectedArtifactCid) {
      setArtifactPreview(null);
      setArtifactPreviewError(null);
      setIsArtifactPreviewLoading(false);
      return;
    }

    let cancelled = false;
    const artifactCid = selectedArtifactCid;

    async function loadArtifactPreview() {
      setIsArtifactPreviewLoading(true);
      setArtifactPreviewError(null);

      try {
        const endpoint = new URL(
          `/api/artifacts/${encodeURIComponent(artifactCid)}`,
          session.apiBaseUrl
        );
        const response = await fetch(endpoint, {
          headers: {
            "x-reviewer-token": session.reviewerToken,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload?.error?.message ??
              "Artifact preview could not be loaded with the current session."
          );
        }

        if (!cancelled) {
          setArtifactPreview(payload.artifact ?? null);
        }
      } catch (error) {
        if (!cancelled) {
          setArtifactPreview(null);
          setArtifactPreviewError(
            error instanceof Error
              ? error.message
              : "Artifact preview could not be loaded with the current session."
          );
        }
      } finally {
        if (!cancelled) {
          setIsArtifactPreviewLoading(false);
        }
      }
    }

    void loadArtifactPreview();

    return () => {
      cancelled = true;
    };
  }, [selectedArtifactCid, session]);

  function handleConnectReviewer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextSession = {
      apiBaseUrl: draftApiBaseUrl.trim().replace(/\/+$/, ""),
      reviewerToken: draftReviewerToken.trim(),
    };

    saveReviewerSession(nextSession);
    setSession(nextSession);
  }

  function handleDisconnectReviewer() {
    clearReviewerSession();
    setDraftApiBaseUrl("");
    setDraftReviewerToken("");
    setSession({
      apiBaseUrl: "",
      reviewerToken: "",
    });
    setQueueResponse(null);
    setPrelaunchQueueResponse(null);
    setErrorMessage(null);
    setPrelaunchErrorMessage(null);
    setDetailResponse(null);
    setPrelaunchDetailResponse(null);
    setDetailErrorMessage(null);
    setPrelaunchDetailErrorMessage(null);
    setArtifactPreview(null);
    setArtifactPreviewError(null);
    setSelectedClarificationId(null);
    setSelectedPrelaunchEventId(null);
    setActiveFilter("all");
  }

  function refreshReviewerData() {
    setRefreshNonce((value) => value + 1);
  }

  async function handleRunPrelaunchScan(eventId: string) {
    if (!session.apiBaseUrl || !session.reviewerToken) {
      return;
    }

    setPrelaunchScanTargetId(eventId);
    setPrelaunchDetailErrorMessage(null);

    try {
      const endpoint = new URL(
        `/api/reviewer/prelaunch/scan/${encodeURIComponent(eventId)}`,
        session.apiBaseUrl
      );
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-reviewer-token": session.reviewerToken,
        },
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Prelaunch scan could not be started.");
      }

      refreshReviewerData();
    } catch (error) {
      setPrelaunchDetailErrorMessage(
        error instanceof Error ? error.message : "Prelaunch scan could not be started."
      );
    } finally {
      setPrelaunchScanTargetId(null);
    }
  }

  async function handleRunPrelaunchScanAll() {
    if (!session.apiBaseUrl || !session.reviewerToken) {
      return;
    }

    setIsPrelaunchScanAllRunning(true);
    setPrelaunchErrorMessage(null);

    try {
      const endpoint = new URL("/api/reviewer/prelaunch/scan-all", session.apiBaseUrl);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-reviewer-token": session.reviewerToken,
        },
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(
          payload?.error?.message ?? "Prelaunch scan-all could not be started."
        );
      }

      refreshReviewerData();
    } catch (error) {
      setPrelaunchErrorMessage(
        error instanceof Error
          ? error.message
          : "Prelaunch scan-all could not be started."
      );
    } finally {
      setIsPrelaunchScanAllRunning(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg1 text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,_rgba(196,168,106,0.22),_transparent_58%)]"
      />
      <main className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col gap-8 border-x border-border-low px-6 py-10">
        <header className="flex flex-col gap-3 border-b border-border-low pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-sm uppercase tracking-[0.18em] text-muted">
              Reviewer Console
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Queue filters for off-chain review
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-muted">
              Segment active markets by persisted scan, funding, expiry, and
              workflow state without waiting for on-chain voting.
            </p>
          </div>
          <a
            className="inline-flex items-center rounded-lg border border-border-low bg-card px-3 py-2 text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm"
            href="/"
          >
            Return to public console
          </a>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_2fr]">
          <form
            className="space-y-4 rounded-[1.75rem] border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]"
            onSubmit={handleConnectReviewer}
          >
            <div className="space-y-1">
              <p className="text-sm uppercase tracking-[0.16em] text-muted">
                Authenticated Session
              </p>
              <h2 className="text-xl font-semibold tracking-tight">
                Fail closed until reviewer credentials are present
              </h2>
            </div>
            <label className="block space-y-2 text-sm">
              <span className="font-medium">Backend API base URL</span>
              <input
                className="w-full rounded-xl border border-border-low bg-bg1 px-3 py-3 text-sm outline-none transition focus:border-border-strong"
                name="apiBaseUrl"
                onChange={(event) => setDraftApiBaseUrl(event.target.value)}
                placeholder="http://127.0.0.1:3101"
                value={draftApiBaseUrl}
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span className="font-medium">Reviewer token</span>
              <input
                className="w-full rounded-xl border border-border-low bg-bg1 px-3 py-3 text-sm outline-none transition focus:border-border-strong"
                name="reviewerToken"
                onChange={(event) => setDraftReviewerToken(event.target.value)}
                placeholder="Internal reviewer token"
                type="password"
                value={draftReviewerToken}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                className="inline-flex items-center rounded-xl bg-foreground px-4 py-3 text-sm font-semibold text-background transition hover:-translate-y-0.5 disabled:opacity-60"
                disabled={!draftApiBaseUrl.trim() || !draftReviewerToken.trim()}
                type="submit"
              >
                Load reviewer queue
              </button>
              <button
                className="inline-flex items-center rounded-xl border border-border-low bg-card px-4 py-3 text-sm font-medium transition hover:-translate-y-0.5"
                onClick={handleDisconnectReviewer}
                type="button"
              >
                Clear session
              </button>
            </div>
            <p className="text-xs leading-5 text-muted">
              The route stays blocked until an internal API base URL and
              reviewer token are provided.
            </p>
          </form>

          <section className="rounded-[1.75rem] border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
            <div className="flex flex-col gap-4 border-b border-border-low pb-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm uppercase tracking-[0.16em] text-muted">
                    Reviewer surface
                  </p>
                  <p className="text-sm text-muted">
                    Switch between active paid clarifications and upcoming prelaunch review.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={`inline-flex items-center rounded-lg border px-3 py-2 text-sm font-medium transition ${
                      reviewerSurface === "active"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border-low bg-cream"
                    }`}
                    onClick={() => {
                      setReviewerSurface("active");
                      setSelectedPrelaunchEventId(null);
                    }}
                    type="button"
                  >
                    Active queue
                  </button>
                  <button
                    className={`inline-flex items-center rounded-lg border px-3 py-2 text-sm font-medium transition ${
                      reviewerSurface === "prelaunch"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border-low bg-cream"
                    }`}
                    onClick={() => {
                      setReviewerSurface("prelaunch");
                      setSelectedClarificationId(null);
                    }}
                    type="button"
                  >
                    Prelaunch queue
                  </button>
                  {session.apiBaseUrl ? (
                    <button
                      className="inline-flex items-center rounded-lg border border-border-low bg-cream px-3 py-2 text-sm font-medium transition hover:-translate-y-0.5"
                      onClick={refreshReviewerData}
                      type="button"
                    >
                      Refresh
                    </button>
                  ) : null}
                  {session.apiBaseUrl && reviewerSurface === "prelaunch" ? (
                    <button
                      className="inline-flex items-center rounded-lg border border-border-low bg-card px-3 py-2 text-sm font-medium transition hover:-translate-y-0.5 disabled:opacity-60"
                      disabled={isPrelaunchScanAllRunning}
                      onClick={handleRunPrelaunchScanAll}
                      type="button"
                    >
                      {isPrelaunchScanAllRunning ? "Scanning upcoming…" : "Scan all upcoming"}
                    </button>
                  ) : null}
                </div>
              </div>

              {reviewerSurface === "active" ? (
                <div
                  className="flex flex-wrap gap-2"
                  data-testid="reviewer-filter-list"
                >
                  <button
                    data-testid="filter-all"
                    className={`rounded-full border px-3 py-2 text-sm transition ${
                      activeFilter === "all"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border-low bg-bg1 text-foreground"
                    }`}
                    onClick={() => setActiveFilter("all")}
                    type="button"
                  >
                    All markets
                  </button>
                  {filters.map((filter) => (
                    <button
                      data-testid={`filter-${filter.key}`}
                      className={`rounded-full border px-3 py-2 text-sm transition ${
                        activeFilter === filter.key
                          ? "border-foreground bg-foreground text-background"
                          : "border-border-low bg-bg1 text-foreground"
                      }`}
                      key={filter.key}
                      onClick={() => setActiveFilter(filter.key)}
                      type="button"
                    >
                      {filter.label}{" "}
                      <span className="opacity-70">({filter.count})</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm leading-6 text-muted">
                  Upcoming Gemini markets live here before they can receive paid clarification requests.
                  Use this queue to proactively scan contracts, category context, and launch timing.
                </p>
              )}
            </div>

            {reviewerSurface === "active" && isLoading ? (
              <div className="py-10 text-sm text-muted">
                Loading reviewer queue…
              </div>
            ) : null}

            {reviewerSurface === "prelaunch" && isPrelaunchLoading ? (
              <div className="py-10 text-sm text-muted">
                Loading prelaunch queue…
              </div>
            ) : null}

            {reviewerSurface === "active" && !isLoading && errorMessage ? (
              <div
                className="mt-4 rounded-2xl border border-border-low bg-bg1 p-4 text-sm text-muted"
                data-testid="reviewer-queue-error"
              >
                {errorMessage}
              </div>
            ) : null}

            {reviewerSurface === "prelaunch" &&
            !isPrelaunchLoading &&
            prelaunchErrorMessage ? (
              <div className="mt-4 rounded-2xl border border-border-low bg-bg1 p-4 text-sm text-muted">
                {prelaunchErrorMessage}
              </div>
            ) : null}

            {reviewerSurface === "active" &&
            !isLoading &&
            !errorMessage &&
            !session.apiBaseUrl ? (
              <div
                className="mt-4 rounded-2xl border border-dashed border-border-low bg-bg1 p-6 text-sm leading-6 text-muted"
                data-testid="reviewer-session-blocked"
              >
                Enter reviewer credentials to unlock the queue. Unauthorized
                sessions stay out of reviewer-only data.
              </div>
            ) : null}

            {reviewerSurface === "prelaunch" &&
            !isPrelaunchLoading &&
            !prelaunchErrorMessage &&
            !session.apiBaseUrl ? (
              <div className="mt-4 rounded-2xl border border-dashed border-border-low bg-bg1 p-6 text-sm leading-6 text-muted">
                Enter reviewer credentials to unlock the prelaunch queue.
              </div>
            ) : null}

            {reviewerSurface === "active" &&
            !isLoading &&
            !errorMessage &&
            session.apiBaseUrl &&
            queueResponse &&
            queueResponse.queue.length === 0 ? (
              <div
                className="mt-4 rounded-2xl border border-dashed border-border-low bg-bg1 p-6 text-sm leading-6 text-muted"
                data-testid="reviewer-empty-state"
              >
                No markets match the <strong>{activeFilter}</strong> filter
                right now.
              </div>
            ) : null}

            {reviewerSurface === "prelaunch" &&
            !isPrelaunchLoading &&
            !prelaunchErrorMessage &&
            session.apiBaseUrl &&
            prelaunchQueueResponse &&
            prelaunchQueue.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-border-low bg-bg1 p-6 text-sm leading-6 text-muted">
                No upcoming Gemini markets are queued for proactive review right now.
              </div>
            ) : null}

            {reviewerSurface === "active" &&
            !isLoading &&
            !errorMessage &&
            queueResponse &&
            queueResponse.queue.length > 0 ? (
              <div className="mt-5 grid gap-4">
                {queueResponse.queue.map((item) => (
                  <article
                    data-testid={`queue-item-${item.eventId}`}
                    className={`rounded-[1.5rem] border bg-bg1 p-5 transition ${
                      selectedClarificationId === item.latestClarificationId &&
                      item.latestClarificationId
                        ? "border-foreground shadow-[0_24px_70px_-50px_rgba(0,0,0,0.5)]"
                        : "border-border-low"
                    }`}
                    key={item.eventId}
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.18em] text-muted">
                            {item.eventId}
                          </p>
                          <h3 className="text-xl font-semibold tracking-tight">
                            {item.marketTitle}
                          </h3>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {item.queueStates.map((state) => (
                            <span
                              className="rounded-full border border-border-low bg-card px-3 py-1 text-xs uppercase tracking-[0.12em] text-muted"
                              key={state}
                            >
                              {formatQueueStateLabel(state)}
                            </span>
                          ))}
                        </div>
                      </div>

                      <dl className="grid min-w-[16rem] grid-cols-2 gap-3 text-sm">
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Ambiguity
                          </dt>
                          <dd className="mt-1 text-lg font-semibold">
                            {formatAmbiguityScore(item.ambiguityScore)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Vote status
                          </dt>
                          <dd className="mt-1 text-lg font-semibold">
                            {formatQueueStateLabel(item.voteStatus)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Funding
                          </dt>
                          <dd className="mt-1 text-lg font-semibold">
                            {item.fundingProgress.raisedAmount}/
                            {item.fundingProgress.targetAmount} USDC
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Review window
                          </dt>
                          <dd className="mt-1 text-lg font-semibold">
                            {Math.round(
                              item.reviewWindow.review_window_secs / 3600
                            )}
                            h
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="mt-5 grid gap-3 text-sm text-muted md:grid-cols-3">
                      <div className="rounded-xl border border-border-low bg-card p-3">
                        <p className="text-xs uppercase tracking-[0.12em]">
                          Market ends
                        </p>
                        <p className="mt-2 text-foreground">
                          {formatTimestamp(item.endTime)}
                        </p>
                      </div>
                      <div className="rounded-xl border border-border-low bg-card p-3">
                        <p className="text-xs uppercase tracking-[0.12em]">
                          Activity signal
                        </p>
                        <p className="mt-2 text-foreground">
                          {formatQueueStateLabel(
                            item.reviewWindow.activity_signal
                          )}
                        </p>
                      </div>
                      <div className="rounded-xl border border-border-low bg-card p-3">
                        <p className="text-xs uppercase tracking-[0.12em]">
                          Contributors
                        </p>
                        <p className="mt-2 text-foreground">
                          {item.fundingProgress.contributorCount}{" "}
                          reviewer-facing funding records
                        </p>
                      </div>
                    </div>

                    <p className="mt-4 text-sm leading-6 text-muted">
                      {item.reviewWindow.review_window_reason}
                    </p>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-low pt-4">
                      <p className="text-xs uppercase tracking-[0.14em] text-muted">
                        {item.latestClarificationId
                          ? `Latest clarification ${item.latestClarificationId}`
                          : "No clarification detail yet"}
                      </p>
                      <button
                        data-testid={`open-detail-${item.eventId}`}
                        className={`inline-flex items-center rounded-full px-4 py-2 text-sm font-medium transition ${
                          item.latestClarificationId
                            ? "border border-border-low bg-card hover:-translate-y-0.5"
                            : "cursor-not-allowed border border-border-low bg-card/60 text-muted"
                        }`}
                        disabled={!item.latestClarificationId}
                        onClick={() =>
                          setSelectedClarificationId(item.latestClarificationId)
                        }
                        type="button"
                      >
                        {item.latestClarificationId
                          ? "Open reviewer detail"
                          : "Awaiting paid request"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}

            {reviewerSurface === "prelaunch" &&
            !isPrelaunchLoading &&
            !prelaunchErrorMessage &&
            prelaunchQueue.length > 0 ? (
              <div className="mt-5 grid gap-4">
                {prelaunchQueue.map((item) => (
                  <article
                    className={`rounded-[1.5rem] border bg-bg1 p-5 transition ${
                      selectedPrelaunchEventId === item.eventId
                        ? "border-foreground shadow-[0_24px_70px_-50px_rgba(0,0,0,0.5)]"
                        : "border-border-low"
                    }`}
                    key={item.eventId}
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.18em] text-muted">
                            {item.eventId} {item.ticker ? `• ${item.ticker}` : ""}
                          </p>
                          <h3 className="text-xl font-semibold tracking-tight">
                            {item.marketTitle}
                          </h3>
                          <p className="text-sm text-muted">
                            {item.category ?? "Uncategorized"} • {item.contracts.length} contract
                            {item.contracts.length === 1 ? "" : "s"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <span className="rounded-full border border-border-low bg-card px-3 py-1 text-xs uppercase tracking-[0.12em] text-muted">
                            {item.status ?? "upcoming"}
                          </span>
                          {item.needsScan ? (
                            <span className="rounded-full border border-border-low bg-card px-3 py-1 text-xs uppercase tracking-[0.12em] text-muted">
                              Needs scan
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <dl className="grid min-w-[16rem] grid-cols-2 gap-3 text-sm">
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Ambiguity
                          </dt>
                          <dd className="mt-1 text-lg font-semibold">
                            {formatAmbiguityScore(item.ambiguityScore)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Review window
                          </dt>
                          <dd className="mt-1 text-lg font-semibold">
                            {Math.round(item.reviewWindow.review_window_secs / 3600)}h
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Starts
                          </dt>
                          <dd className="mt-1 text-sm font-semibold">
                            {formatOptionalTimestamp(item.startsAt)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-card p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Expires
                          </dt>
                          <dd className="mt-1 text-sm font-semibold">
                            {formatTimestamp(item.endTime)}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <p className="mt-4 text-sm leading-6 text-muted">
                      {item.reviewWindow.review_window_reason}
                    </p>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-low pt-4">
                      <p className="text-xs uppercase tracking-[0.14em] text-muted">
                        {item.latestScanId
                          ? `Latest scan ${item.latestScanId}`
                          : "No prelaunch scan recorded yet"}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="inline-flex items-center rounded-full border border-border-low bg-card px-4 py-2 text-sm font-medium transition hover:-translate-y-0.5"
                          onClick={() => setSelectedPrelaunchEventId(item.eventId)}
                          type="button"
                        >
                          Open prelaunch detail
                        </button>
                        <button
                          className="inline-flex items-center rounded-full border border-border-low bg-cream px-4 py-2 text-sm font-medium transition hover:-translate-y-0.5 disabled:opacity-60"
                          disabled={prelaunchScanTargetId === item.eventId}
                          onClick={() => void handleRunPrelaunchScan(item.eventId)}
                          type="button"
                        >
                          {prelaunchScanTargetId === item.eventId ? "Scanning…" : "Run scan"}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}

            <section className="mt-6 rounded-[1.75rem] border border-border-low bg-bg1 p-6">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border-low pb-4">
                <div className="space-y-1">
                  <p className="text-sm uppercase tracking-[0.16em] text-muted">
                    {reviewerSurface === "active"
                      ? "Clarification detail"
                      : "Prelaunch detail"}
                  </p>
                  <h3 className="text-2xl font-semibold tracking-tight">
                    {reviewerSurface === "active"
                      ? "Review the latest off-chain interpretation record"
                      : "Inspect upcoming Gemini markets before they go live"}
                  </h3>
                </div>
                {reviewerSurface === "active" && selectedClarificationId ? (
                  <span className="rounded-full border border-border-low bg-card px-3 py-1 text-xs uppercase tracking-[0.14em] text-muted">
                    {selectedClarificationId}
                  </span>
                ) : null}
                {reviewerSurface === "prelaunch" && selectedPrelaunchEventId ? (
                  <span className="rounded-full border border-border-low bg-card px-3 py-1 text-xs uppercase tracking-[0.14em] text-muted">
                    {selectedPrelaunchEventId}
                  </span>
                ) : null}
              </div>

              {reviewerSurface === "active" && isDetailLoading ? (
                <div className="py-10 text-sm text-muted">
                  Loading clarification detail…
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" && isPrelaunchDetailLoading ? (
                <div className="py-10 text-sm text-muted">
                  Loading prelaunch detail…
                </div>
              ) : null}

              {reviewerSurface === "active" && !isDetailLoading && detailErrorMessage ? (
                <div
                  className="mt-4 rounded-2xl border border-border-low bg-card p-4 text-sm text-muted"
                  data-testid="reviewer-detail-error"
                >
                  {detailErrorMessage}
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" &&
              !isPrelaunchDetailLoading &&
              prelaunchDetailErrorMessage ? (
                <div className="mt-4 rounded-2xl border border-border-low bg-card p-4 text-sm text-muted">
                  {prelaunchDetailErrorMessage}
                </div>
              ) : null}

              {reviewerSurface === "active" &&
              !isDetailLoading &&
              !detailErrorMessage &&
              !selectedClarificationId ? (
                <div
                  className="mt-4 rounded-2xl border border-dashed border-border-low bg-card p-6 text-sm leading-6 text-muted"
                  data-testid="reviewer-detail-empty"
                >
                  Pick a queue item with a paid clarification to inspect market
                  text, interpretation output, funding history, artifact
                  reference, and vote placeholders.
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" &&
              !isPrelaunchDetailLoading &&
              !prelaunchDetailErrorMessage &&
              !selectedPrelaunchEventId ? (
                <div className="mt-4 rounded-2xl border border-dashed border-border-low bg-card p-6 text-sm leading-6 text-muted">
                  Select an upcoming market to inspect category context, contract structure,
                  terms links, and the latest proactive ambiguity scan.
                </div>
              ) : null}

              {reviewerSurface === "active" && !isDetailLoading && !detailErrorMessage && detail ? (
                <div
                  className="mt-5 grid gap-5"
                  data-testid="reviewer-detail-panel"
                >
                  <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                    <article
                      className="rounded-[1.5rem] border border-border-low bg-card p-5"
                      data-testid="reviewer-market-section"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.16em] text-muted">
                            Market text
                          </p>
                          <h4 className="text-xl font-semibold tracking-tight">
                            {detail.market.title ?? detail.eventId}
                          </h4>
                        </div>
                        <span className="rounded-full border border-border-low bg-bg1 px-3 py-1 text-xs uppercase tracking-[0.14em] text-muted">
                          {detail.status}
                        </span>
                      </div>
                      <p className="mt-4 text-sm leading-7 text-muted">
                        {detail.market.resolutionText ??
                          "No market text cached for this clarification."}
                      </p>
                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-muted">
                            Market closes
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            {detail.market.endTime
                              ? formatTimestamp(detail.market.endTime)
                              : "Unavailable"}
                          </p>
                        </div>
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-muted">
                            Source market
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            {detail.market.slug ?? "No slug cached"}
                          </p>
                        </div>
                      </div>
                      {detail.market.category || detail.market.ticker ? (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div className="rounded-xl border border-border-low bg-bg1 p-3">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Category
                            </p>
                            <p className="mt-2 text-sm text-foreground">
                              {detail.market.category ?? "Unavailable"}
                            </p>
                          </div>
                          <div className="rounded-xl border border-border-low bg-bg1 p-3">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Gemini ticker
                            </p>
                            <p className="mt-2 text-sm text-foreground">
                              {detail.market.ticker ?? "Unavailable"}
                            </p>
                          </div>
                        </div>
                      ) : null}
                      {detail.market.tags && detail.market.tags.length > 0 ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {detail.market.tags.map((tag) => (
                            <span
                              className="rounded-full border border-border-low bg-bg1 px-3 py-1 text-xs uppercase tracking-[0.12em] text-muted"
                              key={tag}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {detail.market.contracts && detail.market.contracts.length > 0 ? (
                        <div className="mt-4 rounded-xl border border-border-low bg-bg1 p-4">
                          <p className="text-xs uppercase tracking-[0.12em] text-muted">
                            Cached contracts
                          </p>
                          <div className="mt-3 grid gap-3">
                            {detail.market.contracts.slice(0, 3).map((contract) => (
                              <div
                                className="rounded-xl border border-border-low bg-card p-3"
                                key={contract.id ?? contract.ticker ?? contract.label ?? "contract"}
                              >
                                <p className="text-sm font-semibold text-foreground">
                                  {contract.label ?? "Unnamed contract"}
                                </p>
                                <p className="mt-1 text-xs uppercase tracking-[0.12em] text-muted">
                                  {contract.instrumentSymbol ?? contract.ticker ?? "No Gemini symbol"}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {detail.market.url ? (
                        <a
                          className="mt-4 inline-flex text-sm font-medium underline underline-offset-4"
                          href={detail.market.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open cached market URL
                        </a>
                      ) : null}
                    </article>

                    <article
                      className="rounded-[1.5rem] border border-border-low bg-card p-5"
                      data-testid="reviewer-review-window-section"
                    >
                      <div className="space-y-1">
                        <p className="text-xs uppercase tracking-[0.16em] text-muted">
                          Review window
                        </p>
                        <h4 className="text-xl font-semibold tracking-tight">
                          {Math.round(detail.review_window_secs / 3600)} hour
                          response window
                        </h4>
                      </div>
                      <dl className="mt-5 grid gap-3 text-sm">
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Time bucket
                          </dt>
                          <dd className="mt-2 text-foreground">
                            {formatQueueStateLabel(detail.time_to_end_bucket)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Activity signal
                          </dt>
                          <dd className="mt-2 text-foreground">
                            {formatQueueStateLabel(detail.activity_signal)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Ambiguity
                          </dt>
                          <dd className="mt-2 text-foreground">
                            {detail.ambiguity_score.toFixed(2)}
                          </dd>
                        </div>
                      </dl>
                      <p className="mt-4 text-sm leading-6 text-muted">
                        {detail.review_window_reason}
                      </p>
                    </article>
                  </section>

                  <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                    <article
                      className="rounded-[1.5rem] border border-border-low bg-card p-5"
                      data-testid="reviewer-llm-section"
                    >
                      <div className="space-y-1">
                        <p className="text-xs uppercase tracking-[0.16em] text-muted">
                          LLM interpretation
                        </p>
                        <h4 className="text-xl font-semibold tracking-tight">
                          {detail.llmOutput?.verdict
                            ? formatQueueStateLabel(detail.llmOutput.verdict)
                            : "Interpretation unavailable"}
                        </h4>
                      </div>
                      {detail.llmOutput ? (
                        <div className="mt-5 grid gap-4">
                          <div className="rounded-xl border border-border-low bg-bg1 p-4">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Ambiguity summary
                            </p>
                            <p className="mt-2 text-sm leading-6 text-foreground">
                              {detail.llmOutput.ambiguity_summary}
                            </p>
                          </div>
                          <div className="rounded-xl border border-border-low bg-bg1 p-4">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Suggested edited market text
                            </p>
                            <p className="mt-2 text-sm leading-6 text-foreground">
                              {detail.llmOutput.suggested_market_text}
                            </p>
                          </div>
                          <div className="rounded-xl border border-border-low bg-bg1 p-4">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Suggested clarification note
                            </p>
                            <p className="mt-2 text-sm leading-6 text-foreground">
                              {detail.llmOutput.suggested_note}
                            </p>
                          </div>
                          <div className="rounded-xl border border-border-low bg-bg1 p-4">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Reasoning
                            </p>
                            <p className="mt-2 text-sm leading-6 text-foreground">
                              {detail.llmOutput.reasoning}
                            </p>
                            <p className="mt-3 text-xs uppercase tracking-[0.12em] text-muted">
                              Cited clause
                            </p>
                            <p className="mt-2 text-sm leading-6 text-foreground">
                              {detail.llmOutput.cited_clause}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-xl border border-dashed border-border-low bg-bg1 p-4 text-sm text-muted">
                          No completed LLM output is available on this
                          clarification yet.
                        </div>
                      )}
                    </article>

                    <div className="grid gap-4">
                      <article
                        className="rounded-[1.5rem] border border-border-low bg-card p-5"
                        data-testid="reviewer-artifact-section"
                      >
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.16em] text-muted">
                            Artifact preview
                          </p>
                          <h4 className="text-xl font-semibold tracking-tight">
                            {detail.artifact
                              ? detail.artifact.cid
                              : "No artifact published"}
                          </h4>
                        </div>
                        {detail.artifact ? (
                          <div className="mt-5 grid gap-3 text-sm">
                            <div className="rounded-xl border border-border-low bg-bg1 p-3">
                              <p className="text-xs uppercase tracking-[0.12em] text-muted">
                                Stored reference
                              </p>
                              <p className="mt-2 break-all text-foreground">
                                {detail.artifact.url}
                              </p>
                            </div>
                            {isArtifactPreviewLoading ? (
                              <div className="rounded-xl border border-border-low bg-bg1 p-3 text-muted">
                                Loading authenticated artifact preview…
                              </div>
                            ) : null}
                            {!isArtifactPreviewLoading &&
                            artifactPreviewError ? (
                              <div className="rounded-xl border border-border-low bg-bg1 p-3 text-muted">
                                {artifactPreviewError}
                              </div>
                            ) : null}
                            {!isArtifactPreviewLoading &&
                            !artifactPreviewError &&
                            artifactPreview ? (
                              <div className="grid gap-3">
                                <div className="rounded-xl border border-border-low bg-bg1 p-3">
                                  <p className="text-xs uppercase tracking-[0.12em] text-muted">
                                    Original market text
                                  </p>
                                  <p className="mt-2 leading-6 text-foreground">
                                    {artifactPreview.marketText}
                                  </p>
                                </div>
                                <div className="rounded-xl border border-border-low bg-bg1 p-3">
                                  <p className="text-xs uppercase tracking-[0.12em] text-muted">
                                    Suggested edited text
                                  </p>
                                  <p className="mt-2 leading-6 text-foreground">
                                    {artifactPreview.suggestedEditedMarketText}
                                  </p>
                                </div>
                                <div className="rounded-xl border border-border-low bg-bg1 p-3">
                                  <p className="text-xs uppercase tracking-[0.12em] text-muted">
                                    Clarification note
                                  </p>
                                  <p className="mt-2 leading-6 text-foreground">
                                    {artifactPreview.clarificationNote}
                                  </p>
                                  <p className="mt-3 text-xs text-muted">
                                    Generated{" "}
                                    {formatTimestamp(
                                      artifactPreview.generatedAtUtc
                                    )}
                                  </p>
                                </div>
                              </div>
                            ) : null}
                            {selectedArtifactHref ? (
                              <a
                                className="inline-flex items-center justify-center rounded-full border border-border-low bg-bg1 px-4 py-3 font-medium transition hover:-translate-y-0.5"
                                href={selectedArtifactHref}
                                rel="noreferrer"
                                target="_blank"
                              >
                                Open stored artifact reference
                              </a>
                            ) : null}
                          </div>
                        ) : (
                          <div className="mt-4 rounded-xl border border-dashed border-border-low bg-bg1 p-4 text-sm text-muted">
                            This clarification does not have an artifact
                            reference yet.
                          </div>
                        )}
                      </article>

                      <article
                        className="rounded-[1.5rem] border border-border-low bg-card p-5"
                        data-testid="reviewer-vote-section"
                      >
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.16em] text-muted">
                            Vote placeholder
                          </p>
                          <h4 className="text-xl font-semibold tracking-tight">
                            {detail.vote.label}
                          </h4>
                        </div>
                        <div className="mt-4 rounded-xl border border-border-low bg-bg1 p-4 text-sm leading-6 text-muted">
                          <p>{detail.vote.summary}</p>
                          <p className="mt-3 text-foreground">
                            Placeholder fields active:{" "}
                            {detail.vote.placeholder ? "yes" : "no"}
                          </p>
                          <p className="mt-2 text-foreground">
                            Last workflow update:{" "}
                            {formatTimestamp(detail.vote.updatedAt)}
                          </p>
                        </div>
                      </article>
                      <article
                        className="rounded-[1.5rem] border border-border-low bg-card p-5"
                        data-testid="reviewer-trace-section"
                      >
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.16em] text-muted">
                            LLM trace
                          </p>
                          <h4 className="text-xl font-semibold tracking-tight">
                            {detail.llmTrace?.modelId ??
                              "Trace metadata unavailable"}
                          </h4>
                        </div>
                        {detail.llmTrace ? (
                          <dl className="mt-4 grid gap-3 text-sm">
                            <div className="rounded-xl border border-border-low bg-bg1 p-3">
                              <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                                Prompt template
                              </dt>
                              <dd className="mt-2 text-foreground">
                                {detail.llmTrace.promptTemplateVersion}
                              </dd>
                            </div>
                            <div className="rounded-xl border border-border-low bg-bg1 p-3">
                              <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                                Processing version
                              </dt>
                              <dd className="mt-2 text-foreground">
                                {detail.llmTrace.processingVersion}
                              </dd>
                            </div>
                            <div className="rounded-xl border border-border-low bg-bg1 p-3">
                              <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                                Requested
                              </dt>
                              <dd className="mt-2 text-foreground">
                                {formatTimestamp(detail.llmTrace.requestedAt)}
                              </dd>
                            </div>
                          </dl>
                        ) : (
                          <div className="mt-4 rounded-xl border border-dashed border-border-low bg-bg1 p-4 text-sm text-muted">
                            No trace metadata was stored for this clarification.
                          </div>
                        )}
                      </article>
                    </div>
                  </section>

                  <section className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
                    <article
                      className="rounded-[1.5rem] border border-border-low bg-card p-5"
                      data-testid="reviewer-funding-state-section"
                    >
                      <div className="space-y-1">
                        <p className="text-xs uppercase tracking-[0.16em] text-muted">
                          Funding state
                        </p>
                        <h4 className="text-xl font-semibold tracking-tight">
                          {formatQueueStateLabel(detail.funding.fundingState)}
                        </h4>
                      </div>
                      <dl className="mt-5 grid gap-3 text-sm">
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Raised
                          </dt>
                          <dd className="mt-2 text-foreground">
                            {formatCurrency(detail.funding.raisedAmount)} of{" "}
                            {formatCurrency(detail.funding.targetAmount)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Contributors
                          </dt>
                          <dd className="mt-2 text-foreground">
                            {detail.funding.contributorCount} recorded
                            contributors
                          </dd>
                        </div>
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                            Requested
                          </dt>
                          <dd className="mt-2 text-foreground">
                            {formatTimestamp(detail.createdAt)}
                          </dd>
                        </div>
                      </dl>
                    </article>

                    <article
                      className="rounded-[1.5rem] border border-border-low bg-card p-5"
                      data-testid="reviewer-funding-history-section"
                    >
                      <div className="space-y-1">
                        <p className="text-xs uppercase tracking-[0.16em] text-muted">
                          Funding history
                        </p>
                        <h4 className="text-xl font-semibold tracking-tight">
                          Contribution audit trail
                        </h4>
                      </div>
                      {detail.funding.history.length > 0 ? (
                        <div className="mt-5 grid gap-3">
                          {detail.funding.history.map((entry) => (
                            <div
                              className="rounded-xl border border-border-low bg-bg1 p-4"
                              key={`${entry.contributor}-${entry.timestamp}-${entry.reference ?? "none"}`}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-foreground">
                                    {entry.contributor}
                                  </p>
                                  <p className="mt-1 text-xs uppercase tracking-[0.12em] text-muted">
                                    {entry.reference ?? "No payment reference"}
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p className="text-sm font-medium text-foreground">
                                    {formatCurrency(entry.amount)}
                                  </p>
                                  <p className="mt-1 text-xs text-muted">
                                    {formatTimestamp(entry.timestamp)}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-4 rounded-xl border border-dashed border-border-low bg-bg1 p-4 text-sm text-muted">
                          No funding entries have been recorded for this
                          clarification yet.
                        </div>
                      )}
                    </article>
                  </section>
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" &&
              !isPrelaunchDetailLoading &&
              !prelaunchDetailErrorMessage &&
              prelaunchDetail ? (
                <div className="mt-5 grid gap-5">
                  <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                    <article className="rounded-[1.5rem] border border-border-low bg-card p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.16em] text-muted">
                            Upcoming market
                          </p>
                          <h4 className="text-xl font-semibold tracking-tight">
                            {prelaunchDetail.title ?? selectedPrelaunchEventId}
                          </h4>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {prelaunchDetail.status ? (
                            <span className="rounded-full border border-border-low bg-bg1 px-3 py-1 text-xs uppercase tracking-[0.14em] text-muted">
                              {prelaunchDetail.status}
                            </span>
                          ) : null}
                          {prelaunchDetail.ticker ? (
                            <span className="rounded-full border border-border-low bg-bg1 px-3 py-1 text-xs uppercase tracking-[0.14em] text-muted">
                              {prelaunchDetail.ticker}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-4 text-sm leading-7 text-muted">
                        {prelaunchDetail.description ??
                          prelaunchDetail.resolutionText ??
                          "No market text cached for this upcoming market."}
                      </p>
                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-muted">
                            Category
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            {prelaunchDetail.category ?? "Uncategorized"}
                          </p>
                        </div>
                        <div className="rounded-xl border border-border-low bg-bg1 p-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-muted">
                            Timing
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            Starts {formatOptionalTimestamp(prelaunchDetail.effectiveDate)}
                          </p>
                          <p className="mt-1 text-sm text-foreground">
                            Expires {formatOptionalTimestamp(prelaunchDetail.expiryDate ?? prelaunchDetail.endTime)}
                          </p>
                        </div>
                      </div>
                      {prelaunchDetail.tags && prelaunchDetail.tags.length > 0 ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {prelaunchDetail.tags.map((tag) => (
                            <span
                              className="rounded-full border border-border-low bg-bg1 px-3 py-1 text-xs uppercase tracking-[0.12em] text-muted"
                              key={tag}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-4 flex flex-wrap gap-3">
                        {prelaunchDetail.url ? (
                          <a
                            className="inline-flex text-sm font-medium underline underline-offset-4"
                            href={prelaunchDetail.url}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open Gemini market page
                          </a>
                        ) : null}
                        {prelaunchDetail.termsLink ? (
                          <a
                            className="inline-flex text-sm font-medium underline underline-offset-4"
                            href={prelaunchDetail.termsLink}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open event terms
                          </a>
                        ) : null}
                      </div>
                    </article>

                    <article className="rounded-[1.5rem] border border-border-low bg-card p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-xs uppercase tracking-[0.16em] text-muted">
                            Proactive scan
                          </p>
                          <h4 className="text-xl font-semibold tracking-tight">
                            {prelaunchLatestScan
                              ? formatQueueStateLabel(prelaunchLatestScan.recommendation)
                              : "No scan recorded"}
                          </h4>
                        </div>
                        <button
                          className="inline-flex items-center rounded-full border border-border-low bg-cream px-4 py-2 text-sm font-medium transition hover:-translate-y-0.5 disabled:opacity-60"
                          disabled={prelaunchScanTargetId === selectedPrelaunchEventId}
                          onClick={() =>
                            selectedPrelaunchEventId
                              ? void handleRunPrelaunchScan(selectedPrelaunchEventId)
                              : undefined
                          }
                          type="button"
                        >
                          {prelaunchScanTargetId === selectedPrelaunchEventId
                            ? "Scanning…"
                            : "Run scan"}
                        </button>
                      </div>
                      {prelaunchLatestScan ? (
                        <div className="mt-5 grid gap-3 text-sm">
                          <div className="rounded-xl border border-border-low bg-bg1 p-3">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Ambiguity
                            </p>
                            <p className="mt-2 text-lg font-semibold text-foreground">
                              {formatAmbiguityScore(prelaunchLatestScan.ambiguityScore)}
                            </p>
                          </div>
                          <div className="rounded-xl border border-border-low bg-bg1 p-3">
                            <p className="text-xs uppercase tracking-[0.12em] text-muted">
                              Review window
                            </p>
                            <p className="mt-2 text-sm text-foreground">
                              {prelaunchLatestScan.reviewWindow.review_window_reason}
                            </p>
                          </div>
                          <p className="text-xs uppercase tracking-[0.12em] text-muted">
                            Last scanned {formatTimestamp(prelaunchLatestScan.createdAt)}
                          </p>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-xl border border-dashed border-border-low bg-bg1 p-4 text-sm text-muted">
                          No proactive ambiguity scan has been stored for this upcoming market yet.
                        </div>
                      )}
                    </article>
                  </section>

                  <section className="rounded-[1.5rem] border border-border-low bg-card p-5">
                    <div className="space-y-1">
                      <p className="text-xs uppercase tracking-[0.16em] text-muted">
                        Contracts
                      </p>
                      <h4 className="text-xl font-semibold tracking-tight">
                        {prelaunchDetail.contracts?.length ?? 0} contract
                        {(prelaunchDetail.contracts?.length ?? 0) === 1 ? "" : "s"}
                      </h4>
                    </div>
                    {prelaunchDetail.contracts && prelaunchDetail.contracts.length > 0 ? (
                      <div className="mt-5 grid gap-4 xl:grid-cols-2">
                        {prelaunchDetail.contracts.map((contract) => (
                          <article
                            className="rounded-[1.25rem] border border-border-low bg-bg1 p-4"
                            key={contract.id ?? contract.ticker ?? contract.label ?? "contract"}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold text-foreground">
                                  {contract.label ?? "Unnamed contract"}
                                </p>
                                <p className="text-xs uppercase tracking-[0.12em] text-muted">
                                  {contract.instrumentSymbol ?? contract.ticker ?? "No Gemini symbol"}
                                </p>
                              </div>
                              {contract.marketState ? (
                                <span className="rounded-full border border-border-low bg-card px-3 py-1 text-xs uppercase tracking-[0.12em] text-muted">
                                  {contract.marketState}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-3 text-sm leading-6 text-muted">
                              {contract.description ?? "No contract description cached."}
                            </p>
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                              <div className="rounded-xl border border-border-low bg-card p-3">
                                <p className="text-xs uppercase tracking-[0.12em] text-muted">
                                  Timing
                                </p>
                                <p className="mt-2 text-sm text-foreground">
                                  {formatOptionalTimestamp(contract.expiryDate)}
                                </p>
                              </div>
                              <div className="rounded-xl border border-border-low bg-card p-3">
                                <p className="text-xs uppercase tracking-[0.12em] text-muted">
                                  Price snapshot
                                </p>
                                <p className="mt-2 text-sm text-foreground">
                                  {formatContractPriceSummary(contract.prices)}
                                </p>
                              </div>
                            </div>
                            {contract.termsAndConditionsUrl ? (
                              <a
                                className="mt-4 inline-flex text-sm font-medium underline underline-offset-4"
                                href={contract.termsAndConditionsUrl}
                                rel="noreferrer"
                                target="_blank"
                              >
                                Open contract terms
                              </a>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-dashed border-border-low bg-bg1 p-4 text-sm text-muted">
                        No contracts were cached for this upcoming market.
                      </div>
                    )}
                  </section>
                </div>
              ) : null}
            </section>
          </section>
        </section>
      </main>
    </div>
  );
}

function PublicConsole() {
  const { connectors, connect, disconnect, wallet, status } =
    useWalletConnection();
  const address = wallet?.account.address.toString();

  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg1 text-foreground">
      <main className="relative z-10 mx-auto flex min-h-screen max-w-4xl flex-col gap-10 border-x border-border-low px-6 py-16">
        <header className="space-y-3">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">
            Solana starter kit
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Ship a Solana dapp fast
          </h1>
          <p className="max-w-3xl text-base leading-relaxed text-muted">
            Drop in <code className="font-mono">@solana/react-hooks</code>, wrap
            your tree once, and you get wallet connect/disconnect plus
            ready-to-use hooks for balances and transactions—no manual RPC
            wiring.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-foreground">
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <a
                  className="font-medium underline underline-offset-2"
                  href="https://solana.com/docs"
                  target="_blank"
                  rel="noreferrer"
                >
                  Solana docs
                </a>{" "}
                — core concepts, RPC, programs, and client patterns.
              </div>
            </li>
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <a
                  className="font-medium underline underline-offset-2"
                  href="https://www.anchor-lang.com/docs/introduction"
                  target="_blank"
                  rel="noreferrer"
                >
                  Anchor docs
                </a>{" "}
                — build and test programs with IDL, macros, and type-safe
                clients.
              </div>
            </li>
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <a
                  className="font-medium underline underline-offset-2"
                  href="https://faucet.solana.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Solana faucet (devnet)
                </a>{" "}
                — grab free devnet SOL to try transfers and transactions.
              </div>
            </li>
            <li className="flex gap-2">
              <span
                className="mt-1.5 h-2 w-2 rounded-full bg-foreground/60"
                aria-hidden
              />
              <div>
                <a
                  className="font-medium underline underline-offset-2"
                  href="https://github.com/solana-foundation/solana-kit/tree/main/packages/react-hooks"
                  target="_blank"
                  rel="noreferrer"
                >
                  @solana/react-hooks README
                </a>{" "}
                — how this starter wires the client, connectors, and hooks.
              </div>
            </li>
          </ul>
        </header>

        <section className="w-full max-w-3xl space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-lg font-semibold">Wallet connection</p>
              <p className="text-sm text-muted">
                Pick any discovered connector and manage connect / disconnect in
                one spot.
              </p>
            </div>
            <span className="rounded-full bg-cream px-3 py-1 text-xs font-semibold uppercase tracking-wide text-foreground/80">
              {status === "connected" ? "Connected" : "Not connected"}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {connectors.map((connector) => (
              <button
                key={connector.id}
                onClick={() => connect(connector.id)}
                disabled={status === "connecting"}
                className="group flex cursor-pointer items-center justify-between rounded-xl border border-border-low bg-card px-4 py-3 text-left text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex flex-col">
                  <span className="text-base">{connector.name}</span>
                  <span className="text-xs text-muted">
                    {status === "connecting"
                      ? "Connecting…"
                      : status === "connected" &&
                          wallet?.connector.id === connector.id
                        ? "Active"
                        : "Tap to connect"}
                  </span>
                </span>
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full bg-border-low transition group-hover:bg-primary/80"
                />
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border-low pt-4 text-sm">
            <span className="rounded-lg border border-border-low bg-cream px-3 py-2 font-mono text-xs">
              {address ?? "No wallet connected"}
            </span>
            <button
              onClick={() => disconnect()}
              disabled={status !== "connected"}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border-low bg-card px-3 py-2 font-medium transition hover:-translate-y-0.5 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              Disconnect
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const isReviewerRoute = window.location.pathname.startsWith("/reviewer");

  if (isReviewerRoute) {
    return <ReviewerConsole />;
  }

  return <PublicConsole />;
}
