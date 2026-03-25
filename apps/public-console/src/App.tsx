import { useEffect, useMemo, useState } from "react";
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
    suggested_market_text: string | null;
    suggested_note: string | null;
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
  availableCategories?: string[];
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
  suggestedEditedMarketText: string | null;
  clarificationNote: string | null;
  generatedAtUtc: string;
  cid: string;
  url: string;
};

type IntakeResponseState =
  | {
      kind: "payment_required";
      eventId: string;
      payload: {
        paymentRequirements?: Array<{
          assetSymbol?: string;
          amount?: string;
          description?: string;
          network?: string;
        }>;
      };
    }
  | {
      kind: "accepted";
      eventId: string;
      payload: {
        clarificationId?: string;
        status?: string;
      };
    }
  | {
      kind: "error";
      eventId: string;
      message: string;
    };

const REVIEWER_SESSION_STORAGE_KEY = "gemini-reviewer-session";
const PUBLIC_SESSION_STORAGE_KEY = "signal-public-session";

function loadStoredSession(key: string) {
  if (typeof window === "undefined") {
    return { apiBaseUrl: "", reviewerToken: "" };
  }

  try {
    const raw = window.localStorage.getItem(key);

    if (!raw) {
      return { apiBaseUrl: "", reviewerToken: "" };
    }

    const parsed = JSON.parse(raw);

    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : "",
      reviewerToken: typeof parsed.reviewerToken === "string" ? parsed.reviewerToken : ""
    };
  } catch {
    return { apiBaseUrl: "", reviewerToken: "" };
  }
}

function saveStoredSession(
  key: string,
  session: {
    apiBaseUrl: string;
    reviewerToken: string;
  }
) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(session));
}

function hasVisibleText(value: string | null | undefined) {
  return typeof value === "string" && value.trim() !== "";
}

function clearStoredSession(key: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(key);
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(timestamp));
}

function formatOptionalTimestamp(timestamp?: string | null) {
  return timestamp ? formatTimestamp(timestamp) : "Unavailable";
}

function formatQueueStateLabel(state: string) {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAmbiguityScore(score: number | null) {
  if (typeof score !== "number") {
    return "Pending";
  }

  return score.toFixed(2);
}

function formatCurrency(amount: string) {
  return `${amount} USDC`;
}

function formatContractPriceSummary(prices: Record<string, unknown> | null) {
  if (!prices || typeof prices !== "object") {
    return "No price snapshot";
  }

  const entries = Object.entries(prices)
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 3)
    .map(([key, value]) =>
      typeof value === "object" ? `${key}: ${JSON.stringify(value)}` : `${key}: ${value}`
    );

  return entries.length > 0 ? entries.join(" • ") : "No price snapshot";
}

function getReviewTemperature(score: number | null) {
  if (typeof score !== "number") {
    return "Unscored";
  }

  if (score >= 0.8) {
    return "Critical ambiguity";
  }

  if (score >= 0.5) {
    return "Needs editorial pass";
  }

  return "Stable enough to monitor";
}

function SurfaceSwitch({
  value,
  onChange
}: {
  value: ReviewerSurface;
  onChange: (next: ReviewerSurface) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-border-low bg-panel/60 p-1">
      {([
        ["active", "Live Clarifications"],
        ["prelaunch", "Upcoming Review"]
      ] as const).map(([surface, label]) => (
        <button
          key={surface}
          className={`rounded-full px-4 py-2 text-sm transition ${
            value === surface
              ? "bg-foreground text-background shadow-[0_10px_25px_rgba(0,0,0,0.25)]"
              : "text-muted hover:text-foreground"
          }`}
          onClick={() => onChange(surface)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}


function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10.325 4.317a1.724 1.724 0 0 1 3.35 0l.16.753a1.724 1.724 0 0 0 2.573 1.066l.658-.379a1.724 1.724 0 0 1 2.286.632l.5.866a1.724 1.724 0 0 1-.632 2.286l-.658.379a1.724 1.724 0 0 0-.84 1.493c0 .547.315 1.046.84 1.348l.658.379a1.724 1.724 0 0 1 .632 2.286l-.5.866a1.724 1.724 0 0 1-2.286.632l-.658-.379a1.724 1.724 0 0 0-2.573 1.066l-.16.753a1.724 1.724 0 0 1-3.35 0l-.16-.753a1.724 1.724 0 0 0-2.573-1.066l-.658.379a1.724 1.724 0 0 1-2.286-.632l-.5-.866a1.724 1.724 0 0 1 .632-2.286l.658-.379a1.724 1.724 0 0 0 .84-1.348c0-.547-.315-1.046-.84-1.348l-.658-.379a1.724 1.724 0 0 1-.632-2.286l.5-.866a1.724 1.724 0 0 1 2.286-.632l.658.379a1.724 1.724 0 0 0 2.573-1.066l.16-.753Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <path
        d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function SettingsFlyout({
  title,
  description,
  onClose,
  children
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40">
      <button
        aria-label="Close settings"
        className="absolute inset-0 bg-[rgba(4,13,22,0.48)] backdrop-blur-[2px]"
        onClick={onClose}
        type="button"
      />
      <div className="absolute right-5 top-5 w-[min(30rem,calc(100vw-2.5rem))] rounded-[2rem] border border-border-low bg-panel/95 p-6 shadow-[0_28px_100px_-40px_rgba(4,13,22,0.95)] backdrop-blur-xl sm:right-8 sm:top-8 lg:right-10">
        <div className="flex items-start justify-between gap-4 border-b border-border-low pb-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.26em] text-muted">Settings</p>
            <h2 className="font-display text-[1.7rem] leading-none text-foreground">{title}</h2>
            <p className="max-w-md text-sm leading-6 text-muted">{description}</p>
          </div>
          <button
            aria-label="Close settings"
            className="rounded-full border border-border-low px-3 py-2 text-sm text-muted transition hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

function ReviewerConsole() {
  const initialSession = useMemo(
    () => loadStoredSession(REVIEWER_SESSION_STORAGE_KEY),
    []
  );
  const [draftApiBaseUrl, setDraftApiBaseUrl] = useState(initialSession.apiBaseUrl);
  const [draftReviewerToken, setDraftReviewerToken] = useState(initialSession.reviewerToken);
  const [session, setSession] = useState(initialSession);
  const [reviewerSurface, setReviewerSurface] = useState<ReviewerSurface>("prelaunch");
  const [activeFilter, setActiveFilter] = useState("all");
  const [queueResponse, setQueueResponse] = useState<ReviewerQueueResponse | null>(null);
  const [prelaunchQueueResponse, setPrelaunchQueueResponse] =
    useState<PrelaunchQueueResponse | null>(null);
  const [selectedClarificationId, setSelectedClarificationId] = useState<string | null>(null);
  const [selectedPrelaunchEventId, setSelectedPrelaunchEventId] = useState<string | null>(null);
  const [detailResponse, setDetailResponse] =
    useState<ReviewerClarificationDetailResponse | null>(null);
  const [prelaunchDetailResponse, setPrelaunchDetailResponse] =
    useState<PrelaunchMarketDetailResponse | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<ReviewerArtifactRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [prelaunchErrorMessage, setPrelaunchErrorMessage] = useState<string | null>(null);
  const [detailErrorMessage, setDetailErrorMessage] = useState<string | null>(null);
  const [prelaunchDetailErrorMessage, setPrelaunchDetailErrorMessage] =
    useState<string | null>(null);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPrelaunchLoading, setIsPrelaunchLoading] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isPrelaunchDetailLoading, setIsPrelaunchDetailLoading] = useState(false);
  const [isArtifactPreviewLoading, setIsArtifactPreviewLoading] = useState(false);
  const [prelaunchScanTargetId, setPrelaunchScanTargetId] = useState<string | null>(null);
  const [isPrelaunchScanAllRunning, setIsPrelaunchScanAllRunning] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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
            "x-reviewer-token": session.reviewerToken
          }
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
            "x-reviewer-token": session.reviewerToken
          }
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload?.error?.message ??
              "Upcoming review queue could not be loaded with the current session."
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
              : "Upcoming review queue could not be loaded with the current session."
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

    let cancelled = false;
    const clarificationId = selectedClarificationId;

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
            "x-reviewer-token": session.reviewerToken
          }
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

    let cancelled = false;
    const eventId = selectedPrelaunchEventId;

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
            "x-reviewer-token": session.reviewerToken
          }
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload?.error?.message ??
              "Upcoming market detail could not be loaded with the current session."
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
              : "Upcoming market detail could not be loaded with the current session."
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

  const detail = detailResponse?.clarification ?? null;
  const prelaunchDetail = prelaunchDetailResponse?.market ?? null;
  const prelaunchLatestScan = prelaunchDetailResponse?.latestScan ?? null;
  const selectedArtifactCid = detail?.artifact?.cid ?? null;
  const selectedArtifactHref = buildArtifactLinkHref(detail?.artifact?.url);
  const activeQueue = queueResponse?.queue ?? [];
  const filters = queueResponse?.filters ?? [];
  const prelaunchQueue = prelaunchQueueResponse?.queue ?? [];
  const availableCategories = prelaunchQueueResponse?.availableCategories ?? [];

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
            "x-reviewer-token": session.reviewerToken
          }
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

  function connectReviewer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextSession = {
      apiBaseUrl: draftApiBaseUrl.trim().replace(/\/+$/, ""),
      reviewerToken: draftReviewerToken.trim()
    };

    saveStoredSession(REVIEWER_SESSION_STORAGE_KEY, nextSession);
    setSession(nextSession);
    setIsSettingsOpen(false);
  }

  function clearReviewer() {
    clearStoredSession(REVIEWER_SESSION_STORAGE_KEY);
    setDraftApiBaseUrl("");
    setDraftReviewerToken("");
    setSession({ apiBaseUrl: "", reviewerToken: "" });
    setQueueResponse(null);
    setPrelaunchQueueResponse(null);
    setSelectedClarificationId(null);
    setSelectedPrelaunchEventId(null);
    setDetailResponse(null);
    setPrelaunchDetailResponse(null);
    setArtifactPreview(null);
    setArtifactPreviewError(null);
    setActiveFilter("all");
    setIsSettingsOpen(false);
  }

  function refreshReviewerData() {
    setRefreshNonce((value) => value + 1);
  }

  async function runPrelaunchScan(eventId: string) {
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
          "x-reviewer-token": session.reviewerToken
        }
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Upcoming scan could not be started.");
      }

      refreshReviewerData();
    } catch (error) {
      setPrelaunchDetailErrorMessage(
        error instanceof Error ? error.message : "Upcoming scan could not be started."
      );
    } finally {
      setPrelaunchScanTargetId(null);
    }
  }

  async function runPrelaunchScanAll() {
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
          "x-reviewer-token": session.reviewerToken
        }
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Upcoming scan-all could not be started.");
      }

      refreshReviewerData();
    } catch (error) {
      setPrelaunchErrorMessage(
        error instanceof Error ? error.message : "Upcoming scan-all could not be started."
      );
    } finally {
      setIsPrelaunchScanAllRunning(false);
    }
  }

  const openCount = prelaunchQueue.filter((item) => item.needsScan).length;
  const liveNeedsAttention = activeQueue.filter((item) =>
    item.queueStates.includes("needs_scan") || item.queueStates.includes("high_ambiguity")
  ).length;

  return (
    <div className="min-h-screen">
      {isSettingsOpen ? (
        <SettingsFlyout
          description="Connect this desk to a backend and reviewer token when you need queue and detail access."
          onClose={() => setIsSettingsOpen(false)}
          title="Reviewer connection"
        >
          <form className="grid gap-4" onSubmit={connectReviewer}>
            <label className="grid gap-2 text-sm">
              <span className="text-muted">Backend API base URL</span>
              <input
                className="rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                onChange={(event) => setDraftApiBaseUrl(event.target.value)}
                placeholder="http://127.0.0.1:3000"
                value={draftApiBaseUrl}
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="text-muted">Reviewer auth token</span>
              <input
                className="rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                onChange={(event) => setDraftReviewerToken(event.target.value)}
                placeholder="demo-reviewer-token"
                type="password"
                value={draftReviewerToken}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                className="rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background transition hover:translate-y-[-1px]"
                disabled={!draftApiBaseUrl.trim() || !draftReviewerToken.trim()}
                type="submit"
              >
                Save
              </button>
              <button
                className="rounded-full border border-border-low px-5 py-3 text-sm text-muted transition hover:text-foreground"
                onClick={refreshReviewerData}
                type="button"
              >
                Refresh
              </button>
              <button
                className="rounded-full border border-border-low px-5 py-3 text-sm text-muted transition hover:text-foreground"
                onClick={clearReviewer}
                type="button"
              >
                Clear
              </button>
            </div>
          </form>
        </SettingsFlyout>
      ) : null}

      <NavBar onOpenSettings={() => setIsSettingsOpen(true)} contextLink={{ href: "/", label: "Public intake" }} />

      <div className="border-b border-border-low">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-6 px-5 py-6 sm:px-8 lg:px-10">
          <div>
            <p className="text-xs uppercase tracking-[0.34em] text-muted">Review Desk</p>
            <h1 className="animate-fade-up mt-1 font-display text-[clamp(2rem,4vw,3.6rem)] leading-none text-foreground">
              The Oracle's Desk
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-[1.2rem] border border-border-low bg-panel/80 px-4 py-3 backdrop-blur">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Unscanned</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">{openCount}</p>
            </div>
            <div className="rounded-[1.2rem] border border-border-low bg-panel/80 px-4 py-3 backdrop-blur">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Needs attention</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">{liveNeedsAttention}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10">
        <main className="grid gap-6 xl:grid-cols-[0.88fr_1.12fr]">
          <div className="animate-fade-up overflow-hidden rounded-[2rem] border border-border-low bg-panel/85 shadow-[0_24px_80px_-48px_rgba(4,13,22,0.6)] backdrop-blur">
            {/* Surface switch + scan-all */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-low p-5">
              <SurfaceSwitch
                onChange={(next) => {
                  setReviewerSurface(next);
                  if (next === "active") {
                    setSelectedPrelaunchEventId(null);
                  } else {
                    setSelectedClarificationId(null);
                  }
                }}
                value={reviewerSurface}
              />
              {reviewerSurface === "prelaunch" && session.apiBaseUrl ? (
                <button
                  className="rounded-full border border-border-low px-4 py-2 text-sm text-muted transition hover:text-foreground disabled:opacity-60"
                  disabled={isPrelaunchScanAllRunning}
                  onClick={runPrelaunchScanAll}
                  type="button"
                >
                  {isPrelaunchScanAllRunning ? "Scanning…" : "Scan all upcoming"}
                </button>
              ) : null}
            </div>

            {/* Filter / category chips */}
            {reviewerSurface === "active" ? (
              <div className="flex flex-wrap gap-2 border-b border-border-low px-5 py-3">
                <button
                  className={`rounded-full px-3 py-1.5 text-sm transition ${activeFilter === "all" ? "bg-foreground text-background" : "border border-border-low text-muted"}`}
                  onClick={() => setActiveFilter("all")}
                  type="button"
                >
                  All
                </button>
                {filters.map((filter) => (
                  <button
                    key={filter.key}
                    className={`rounded-full px-3 py-1.5 text-sm transition ${activeFilter === filter.key ? "bg-foreground text-background" : "border border-border-low text-muted"}`}
                    onClick={() => setActiveFilter(filter.key)}
                    type="button"
                  >
                    {filter.label} ({filter.count})
                  </button>
                ))}
              </div>
            ) : availableCategories.length > 0 ? (
              <div className="flex flex-wrap gap-2 border-b border-border-low px-5 py-3">
                {availableCategories.slice(0, 8).map((category) => (
                  <span key={category} className="rounded-full border border-border-low px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-muted">
                    {category}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Queue list */}
            <div className="space-y-3 p-4">
              {!session.apiBaseUrl || !session.reviewerToken ? (
                <div className="rounded-[1.6rem] border border-dashed border-border-low bg-card/60 p-5 text-sm leading-6 text-muted">
                  Add reviewer credentials to load queue data.
                </div>
              ) : null}

              {reviewerSurface === "active" && isLoading ? (
                <div className="py-4 text-sm text-muted">Loading live queue…</div>
              ) : null}
              {reviewerSurface === "prelaunch" && isPrelaunchLoading ? (
                <div className="py-4 text-sm text-muted">Loading upcoming queue…</div>
              ) : null}
              {reviewerSurface === "active" && errorMessage ? (
                <div className="rounded-[1.6rem] border border-border-low bg-card p-4 text-sm text-muted">
                  {errorMessage}
                </div>
              ) : null}
              {reviewerSurface === "prelaunch" && prelaunchErrorMessage ? (
                <div className="rounded-[1.6rem] border border-border-low bg-card p-4 text-sm text-muted">
                  {prelaunchErrorMessage}
                </div>
              ) : null}

              {reviewerSurface === "active" && !isLoading && !errorMessage && activeQueue.length === 0 ? (
                <div className="rounded-[1.6rem] border border-dashed border-border-low bg-card/60 p-5 text-sm leading-6 text-muted">
                  No live markets match the current filter.
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" &&
              !isPrelaunchLoading &&
              !prelaunchErrorMessage &&
              prelaunchQueue.length === 0 ? (
                <div className="rounded-[1.6rem] border border-dashed border-border-low bg-card/60 p-5 text-sm leading-6 text-muted">
                  No upcoming markets are currently queued for review.
                </div>
              ) : null}

              {reviewerSurface === "active" && activeQueue.length > 0 ? (
                <div className="grid gap-3">
                  {activeQueue.map((item) => (
                    <article
                      key={item.eventId}
                      className={`rounded-[1.6rem] border p-4 transition ${
                        item.latestClarificationId &&
                        item.latestClarificationId === selectedClarificationId
                          ? "border-foreground/50 bg-card shadow-[0_12px_40px_-24px_rgba(4,13,22,0.5)]"
                          : "border-border-low bg-card/70"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1.5">
                          <p className="text-xs uppercase tracking-[0.2em] text-muted">{item.eventId}</p>
                          <h3 className="text-base font-medium text-foreground">{item.marketTitle}</h3>
                          <div className="flex flex-wrap gap-1.5">
                            {item.queueStates.map((state) => (
                              <span key={state} className="rounded-full border border-border-low px-2.5 py-0.5 text-xs uppercase tracking-[0.14em] text-muted">
                                {formatQueueStateLabel(state)}
                              </span>
                            ))}
                          </div>
                        </div>
                        {item.ambiguityScore !== null ? (
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${item.ambiguityScore >= 0.6 ? "bg-signal/[0.12] text-signal" : "bg-foreground/[0.08] text-muted"}`}>
                            {formatAmbiguityScore(item.ambiguityScore)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-low pt-3">
                        <p className="text-xs text-muted">{formatTimestamp(item.endTime)}</p>
                        <button
                          className="rounded-full border border-border-low px-3 py-1.5 text-sm text-muted transition hover:text-foreground disabled:opacity-50"
                          disabled={!item.latestClarificationId}
                          onClick={() => setSelectedClarificationId(item.latestClarificationId)}
                          type="button"
                        >
                          Open detail
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" && prelaunchQueue.length > 0 ? (
                <div className="grid gap-3">
                  {prelaunchQueue.map((item) => (
                    <article
                      key={item.eventId}
                      className={`rounded-[1.6rem] border p-4 transition ${
                        item.eventId === selectedPrelaunchEventId
                          ? "border-foreground/50 bg-card shadow-[0_12px_40px_-24px_rgba(4,13,22,0.5)]"
                          : "border-border-low bg-card/70"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1.5">
                          <p className="text-xs uppercase tracking-[0.2em] text-muted">
                            {item.eventId}{item.ticker ? ` · ${item.ticker}` : ""}
                          </p>
                          <h3 className="text-base font-medium text-foreground">{item.marketTitle}</h3>
                          <div className="flex flex-wrap gap-1.5">
                            <span className="rounded-full border border-border-low px-2.5 py-0.5 text-xs uppercase tracking-[0.14em] text-muted">
                              {item.category ?? "Uncategorized"}
                            </span>
                            {item.needsScan ? (
                              <span className="rounded-full bg-signal/[0.12] px-2.5 py-0.5 text-xs uppercase tracking-[0.14em] text-signal">
                                Needs scan
                              </span>
                            ) : null}
                          </div>
                        </div>
                        {item.ambiguityScore !== null ? (
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${item.ambiguityScore >= 0.6 ? "bg-signal/[0.12] text-signal" : "bg-foreground/[0.08] text-muted"}`}>
                            {formatAmbiguityScore(item.ambiguityScore)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-low pt-3">
                        <p className="text-xs text-muted">{formatTimestamp(item.endTime)}</p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded-full border border-border-low px-3 py-1.5 text-sm text-muted transition hover:text-foreground"
                            onClick={() => setSelectedPrelaunchEventId(item.eventId)}
                            type="button"
                          >
                            Inspect
                          </button>
                          <button
                            className="rounded-full bg-foreground px-3 py-1.5 text-sm text-background transition disabled:opacity-60"
                            disabled={prelaunchScanTargetId === item.eventId}
                            onClick={() => void runPrelaunchScan(item.eventId)}
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
            </div>
          </div>

          <div className="animate-fade-up animation-delay-100 overflow-hidden rounded-[2rem] border border-border-low bg-panel/85 shadow-[0_24px_80px_-48px_rgba(4,13,22,0.6)] backdrop-blur">
            {reviewerSurface === "active" && isDetailLoading ? (
              <div className="p-6 text-sm text-muted">Loading clarification detail…</div>
            ) : null}
            {reviewerSurface === "prelaunch" && isPrelaunchDetailLoading ? (
              <div className="p-6 text-sm text-muted">Loading upcoming market detail…</div>
            ) : null}
            {reviewerSurface === "active" && detailErrorMessage ? (
              <div className="p-6">
                <div className="rounded-[1.6rem] border border-border-low bg-card p-4 text-sm text-muted">{detailErrorMessage}</div>
              </div>
            ) : null}
            {reviewerSurface === "prelaunch" && prelaunchDetailErrorMessage ? (
              <div className="p-6">
                <div className="rounded-[1.6rem] border border-border-low bg-card p-4 text-sm text-muted">{prelaunchDetailErrorMessage}</div>
              </div>
            ) : null}

            {reviewerSurface === "active" && !detail && !isDetailLoading && !detailErrorMessage ? (
              <div className="flex min-h-[32rem] flex-col items-center justify-center gap-4 p-10 text-center">
                <span className="text-muted/30">
                  <svg aria-hidden="true" className="h-12 w-12" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />
                    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />
                  </svg>
                </span>
                <h3 className="font-display text-[1.6rem] leading-none text-foreground/60">Select a clarification</h3>
                <p className="max-w-xs text-sm leading-6 text-muted">Choose a live clarification from the queue to inspect its wording, funding, and oracle output.</p>
              </div>
            ) : null}

            {reviewerSurface === "prelaunch" && !prelaunchDetail && !isPrelaunchDetailLoading && !prelaunchDetailErrorMessage ? (
              <div className="flex min-h-[32rem] flex-col items-center justify-center gap-4 p-10 text-center">
                <span className="text-muted/30">
                  <svg aria-hidden="true" className="h-12 w-12" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />
                    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />
                  </svg>
                </span>
                <h3 className="font-display text-[1.6rem] leading-none text-foreground/60">Select a market</h3>
                <p className="max-w-xs text-sm leading-6 text-muted">Choose an upcoming market from the queue to inspect its contract structure and ambiguity scan.</p>
              </div>
            ) : null}

            {reviewerSurface === "active" && detail ? (
                <div className="grid gap-5">
                  <article className="rounded-[1.6rem] border border-border-low bg-card p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted">
                          {detail.market.marketId ?? detail.eventId}
                        </p>
                        <h3 className="mt-2 text-2xl font-semibold text-foreground">
                          {detail.market.title ?? detail.eventId}
                        </h3>
                      </div>
                      <div className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-muted">
                        {detail.status}
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-muted">Question</p>
                        <p className="mt-2 text-sm leading-6 text-foreground">{detail.question}</p>
                      </div>
                      <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-muted">Timing</p>
                        <p className="mt-2 text-sm leading-6 text-foreground">
                          Requested {formatTimestamp(detail.createdAt)}
                          <br />
                          Updated {formatTimestamp(detail.updatedAt)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 rounded-[1.4rem] border border-border-low bg-bg1/80 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-muted">
                        Source market text
                      </p>
                      <p className="mt-3 text-sm leading-7 text-foreground">
                        {detail.market.resolutionText ?? "No market text cached."}
                      </p>
                    </div>
                  </article>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <article className="rounded-[1.6rem] border border-border-low bg-card p-5">
                      <p className="text-xs uppercase tracking-[0.18em] text-muted">
                        Interpretation
                      </p>
                      {detail.llmOutput ? (
                        <div className="mt-4 space-y-4">
                          <div>
                            <p className="text-2xl font-semibold text-foreground">
                              {getReviewTemperature(detail.llmOutput.ambiguity_score)}
                            </p>
                            <p className="mt-2 text-sm text-muted">
                              {detail.llmOutput.ambiguity_summary}
                            </p>
                          </div>
                          {hasVisibleText(detail.llmOutput.suggested_market_text) ? (
                            <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                              <p className="text-xs uppercase tracking-[0.14em] text-muted">
                                Suggested wording
                              </p>
                              <p className="mt-2 text-sm leading-6 text-foreground">
                                {detail.llmOutput.suggested_market_text}
                              </p>
                            </div>
                          ) : null}
                          {hasVisibleText(detail.llmOutput.suggested_note) ? (
                            <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                              <p className="text-xs uppercase tracking-[0.14em] text-muted">
                                Note
                              </p>
                              <p className="mt-2 text-sm leading-6 text-foreground">
                                {detail.llmOutput.suggested_note}
                              </p>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-4 rounded-2xl border border-dashed border-border-low bg-bg1/80 p-4 text-sm text-muted">
                          No LLM output has been persisted for this clarification.
                        </div>
                      )}
                    </article>

                    <article className="rounded-[1.6rem] border border-border-low bg-card p-5">
                      <p className="text-xs uppercase tracking-[0.18em] text-muted">Funding + Review</p>
                      <div className="mt-4 grid gap-3">
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">Funding</p>
                          <p className="mt-2 text-sm text-foreground">
                            {formatCurrency(detail.funding.raisedAmount)} of{" "}
                            {formatCurrency(detail.funding.targetAmount)}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">
                            Review window
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            {detail.review_window_reason}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">Vote state</p>
                          <p className="mt-2 text-sm text-foreground">{detail.vote.label}</p>
                        </div>
                      </div>
                    </article>
                  </div>

                  <article className="rounded-[1.6rem] border border-border-low bg-card p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs uppercase tracking-[0.18em] text-muted">
                        Artifact + contribution trace
                      </p>
                      {selectedArtifactHref ? (
                        <a
                          className="text-sm text-muted underline underline-offset-4 transition hover:text-foreground"
                          href={selectedArtifactHref}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open artifact
                        </a>
                      ) : null}
                    </div>
                    <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                      <div className="rounded-2xl border border-border-low bg-bg1/80 p-4">
                        <p className="text-xs uppercase tracking-[0.14em] text-muted">
                          Artifact preview
                        </p>
                        {isArtifactPreviewLoading ? (
                          <p className="mt-3 text-sm text-muted">Loading artifact preview…</p>
                        ) : artifactPreviewError ? (
                          <p className="mt-3 text-sm text-muted">{artifactPreviewError}</p>
                        ) : artifactPreview ? (
                          <div className="mt-3 space-y-3">
                            {hasVisibleText(artifactPreview.suggestedEditedMarketText) ? (
                              <p className="text-sm text-foreground">
                                {artifactPreview.suggestedEditedMarketText}
                              </p>
                            ) : null}
                            {hasVisibleText(artifactPreview.clarificationNote) ? (
                              <p className="text-sm text-muted">
                                {artifactPreview.clarificationNote}
                              </p>
                            ) : null}
                            {!hasVisibleText(artifactPreview.suggestedEditedMarketText) &&
                            !hasVisibleText(artifactPreview.clarificationNote) ? (
                              <p className="text-sm text-muted">
                                This clarification answered the question without proposing an edit.
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <p className="mt-3 text-sm text-muted">
                            No artifact preview is available for this clarification.
                          </p>
                        )}
                      </div>
                      <div className="grid gap-3">
                        {detail.funding.history.length > 0 ? (
                          detail.funding.history.map((entry) => (
                            <div
                              key={`${entry.contributor}-${entry.timestamp}-${entry.reference ?? "none"}`}
                              className="rounded-2xl border border-border-low bg-bg1/80 p-4"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-foreground">
                                    {entry.contributor}
                                  </p>
                                  <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted">
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
                          ))
                        ) : (
                          <div className="rounded-2xl border border-dashed border-border-low bg-bg1/80 p-4 text-sm text-muted">
                            No funding history is recorded yet.
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" && prelaunchDetail ? (
                <div className="grid gap-5">
                  <article className="rounded-[1.6rem] border border-border-low bg-card p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted">
                          {prelaunchDetail.marketId ?? selectedPrelaunchEventId}
                        </p>
                        <h3 className="mt-2 text-2xl font-semibold text-foreground">
                          {prelaunchDetail.title ?? selectedPrelaunchEventId}
                        </h3>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {prelaunchDetail.status ? (
                          <span className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-muted">
                            {prelaunchDetail.status}
                          </span>
                        ) : null}
                        {prelaunchDetail.ticker ? (
                          <span className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-muted">
                            {prelaunchDetail.ticker}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-4 rounded-[1.4rem] border border-border-low bg-bg1/80 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-muted">Market text</p>
                      <p className="mt-3 text-sm leading-7 text-foreground">
                        {prelaunchDetail.description ??
                          prelaunchDetail.resolutionText ??
                          "No market text cached for this market."}
                      </p>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-muted">Category</p>
                        <p className="mt-2 text-sm text-foreground">
                          {prelaunchDetail.category ?? "Uncategorized"}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-muted">Window</p>
                        <p className="mt-2 text-sm text-foreground">
                          Starts {formatOptionalTimestamp(prelaunchDetail.effectiveDate)}
                          <br />
                          Ends{" "}
                          {formatOptionalTimestamp(
                            prelaunchDetail.expiryDate ?? prelaunchDetail.endTime
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      {prelaunchDetail.url ? (
                        <a
                          className="text-sm text-muted underline underline-offset-4 transition hover:text-foreground"
                          href={prelaunchDetail.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open source market page
                        </a>
                      ) : null}
                      {prelaunchDetail.termsLink ? (
                        <a
                          className="text-sm text-muted underline underline-offset-4 transition hover:text-foreground"
                          href={prelaunchDetail.termsLink}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open terms
                        </a>
                      ) : null}
                    </div>
                  </article>

                  <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
                    <article className="rounded-[1.6rem] border border-border-low bg-card p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.18em] text-muted">
                            Ambiguity scan
                          </p>
                          <p className="mt-2 text-2xl font-semibold text-foreground">
                            {prelaunchLatestScan
                              ? getReviewTemperature(prelaunchLatestScan.ambiguityScore)
                              : "No stored scan"}
                          </p>
                        </div>
                        <button
                          className="rounded-full bg-foreground px-4 py-2 text-sm text-background transition disabled:opacity-60"
                          disabled={prelaunchScanTargetId === selectedPrelaunchEventId}
                          onClick={() =>
                            selectedPrelaunchEventId
                              ? void runPrelaunchScan(selectedPrelaunchEventId)
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
                        <div className="mt-4 grid gap-3">
                          <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                            <p className="text-xs uppercase tracking-[0.14em] text-muted">
                              Score
                            </p>
                            <p className="mt-2 text-sm text-foreground">
                              {formatAmbiguityScore(prelaunchLatestScan.ambiguityScore)}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                            <p className="text-xs uppercase tracking-[0.14em] text-muted">
                              Recommendation
                            </p>
                            <p className="mt-2 text-sm text-foreground">
                              {formatQueueStateLabel(prelaunchLatestScan.recommendation)}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                            <p className="text-xs uppercase tracking-[0.14em] text-muted">
                              Reason
                            </p>
                            <p className="mt-2 text-sm text-foreground">
                              {prelaunchLatestScan.reviewWindow.review_window_reason}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-2xl border border-dashed border-border-low bg-bg1/80 p-4 text-sm text-muted">
                          This market has not been scanned yet.
                        </div>
                      )}
                    </article>

                    <article className="rounded-[1.6rem] border border-border-low bg-card p-5">
                      <p className="text-xs uppercase tracking-[0.18em] text-muted">Contract map</p>
                      {prelaunchDetail.contracts && prelaunchDetail.contracts.length > 0 ? (
                        <div className="mt-4 grid gap-3">
                          {prelaunchDetail.contracts.map((contract) => (
                            <div
                              key={contract.id ?? contract.ticker ?? contract.label ?? "contract"}
                              className="rounded-2xl border border-border-low bg-bg1/80 p-4"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-foreground">
                                    {contract.label ?? "Unnamed contract"}
                                  </p>
                                  <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted">
                                    {contract.instrumentSymbol ?? contract.ticker ?? "No symbol"}
                                  </p>
                                </div>
                                {contract.marketState ? (
                                  <span className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-muted">
                                    {contract.marketState}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-3 text-sm leading-6 text-muted">
                                {contract.description ?? "No contract description cached."}
                              </p>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div className="rounded-2xl border border-border-low bg-card/70 p-3">
                                  <p className="text-xs uppercase tracking-[0.14em] text-muted">
                                    Expiry
                                  </p>
                                  <p className="mt-2 text-sm text-foreground">
                                    {formatOptionalTimestamp(contract.expiryDate)}
                                  </p>
                                </div>
                                <div className="rounded-2xl border border-border-low bg-card/70 p-3">
                                  <p className="text-xs uppercase tracking-[0.14em] text-muted">
                                    Price
                                  </p>
                                  <p className="mt-2 text-sm text-foreground">
                                    {formatContractPriceSummary(contract.prices)}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-4 rounded-2xl border border-dashed border-border-low bg-bg1/80 p-4 text-sm text-muted">
                          No contracts were cached for this upcoming market.
                        </div>
                      )}
                    </article>
                  </div>
                </div>
              ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function OracleEyeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <circle
        className="oracle-pupil"
        cx="12"
        cy="12"
        r="3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function NavBar({ onOpenSettings, contextLink }: { onOpenSettings: () => void; contextLink: { href: string; label: string } }) {
  return (
    <nav className="sticky top-0 z-30 border-b border-border-low bg-panel/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3.5 sm:px-8 lg:px-10">
        <div className="flex items-center gap-2.5">
          <span className="text-signal">
            <OracleEyeIcon />
          </span>
          <span className="font-display text-[1.35rem] leading-none text-foreground">
            The Oracle's Wakeup Call
          </span>
          <span className="hidden rounded-full border border-border-low px-2.5 py-0.5 text-[10px] uppercase tracking-[0.22em] text-muted sm:inline">
            Beta
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a
            href={contextLink.href}
            className="hidden text-sm text-muted transition hover:text-foreground sm:inline"
          >
            {contextLink.label}
          </a>
          <button
            aria-label="Open settings"
            onClick={onOpenSettings}
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border-low bg-card/80 text-muted transition hover:text-foreground"
          >
            <SettingsIcon />
          </button>
        </div>
      </div>
    </nav>
  );
}

function PublicHero() {
  return (
    <section className="mx-auto max-w-7xl px-5 pb-16 pt-20 sm:px-8 lg:px-10">
      <div>
        <h1 className="animate-fade-up font-display text-[clamp(3.4rem,8vw,7.5rem)] leading-[0.86] text-foreground">
          Ambiguous markets
          <br />
          <em className="not-italic text-signal">cost everyone.</em>
        </h1>
        <p className="animate-fade-up animation-delay-100 mt-8 max-w-2xl text-lg leading-8 text-muted sm:text-xl">
          When resolution criteria are unclear, traders dispute outcomes, platforms absorb
          reputational damage, and edge cases go to lawyers — not editors. The Oracle's
          Wakeup Call sends an AI-powered alert the moment ambiguous wording surfaces,
          before it becomes a settlement problem.
        </p>
        <div className="animate-fade-up animation-delay-200 mt-10 flex flex-wrap gap-4">
          <a
            href="#intake"
            className="rounded-full bg-foreground px-6 py-3.5 text-base font-medium text-background transition hover:translate-y-[-1px]"
          >
            Submit a clarification
          </a>
          <a
            href="/reviewer"
            className="rounded-full border border-border-low px-6 py-3.5 text-base text-muted transition hover:text-foreground"
          >
            See the reviewer desk
          </a>
        </div>
      </div>
    </section>
  );
}

const HOW_IT_WORKS_STEPS = [
  {
    step: "01",
    title: "Trader submits a question",
    body: "A trader who spots vague resolution criteria opens a clarification request against the market ID for $1. The fee keeps submissions honest — not expensive."
  },
  {
    step: "02",
    title: "The oracle wakes up",
    body: "An LLM reads the market's full resolution text, scores ambiguity 0–1, and cites the specific clause at issue. It issues a clarification note — and suggests a light edit to the wording only if the wording itself is the problem."
  },
  {
    step: "03",
    title: "Verdict published automatically",
    body: "The clarification and any suggested note are published immediately — no human gate. The full reasoning trace is stored for audit. Crowdfunded escalation to a review panel is available for high-stakes disputes."
  }
] as const;

function HowItWorksStrip() {
  return (
    <section className="border-t border-border-low bg-card/40">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
        <p className="text-xs uppercase tracking-[0.30em] text-muted">How it works</p>
        <h2 className="mt-2 font-display text-[clamp(2rem,4vw,3.2rem)] leading-none text-foreground">
          Three steps from question to decision
        </h2>
        <div className="mt-12 grid gap-0 lg:grid-cols-3">
          {HOW_IT_WORKS_STEPS.map(({ step, title, body }, i) => (
            <div
              key={step}
              className={`scroll-fade-up relative p-8 ${i < HOW_IT_WORKS_STEPS.length - 1 ? "border-b border-border-low lg:border-b-0 lg:border-r" : ""}`}
            >
              <p className="select-none font-display text-[5rem] leading-none text-foreground/[0.06]">
                {step}
              </p>
              <h3 className="mt-4 text-xl font-semibold text-foreground">{title}</h3>
              <p className="mt-3 text-base leading-7 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const BEFORE_ISSUES = [
  "\"Recession\" is undefined — NBER declaration and two consecutive negative GDP quarters are different standards",
  "No GDP release vintage named — advance, second, and third estimates often diverge",
  "Silent on whether a later BEA revision that reverses a negative quarter changes the outcome"
] as const;

const AFTER_FIXES = [
  "Resolution binds exclusively to the BEA advance GDP estimate — NBER declaration is not sufficient",
  "Two consecutive quarters of negative BEA advance real GDP growth required",
  "Later revisions to the advance estimate do not affect settlement once the advance figure is published"
] as const;

function BeforeAfterDemo() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
      <p className="text-xs uppercase tracking-[0.30em] text-muted">Real Gemini market · #4020</p>
      <h2 className="mt-2 font-display text-[clamp(2rem,4vw,3.2rem)] leading-none text-foreground">
        See the difference clarity makes
      </h2>
      <p className="mt-4 max-w-2xl text-base leading-7 text-muted">
        The left card shows market wording as-written. The right shows the oracle's clarification
        note and light edit — published automatically, seconds after submission.
      </p>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        {/* BEFORE */}
        <div className="card-lift rounded-[2rem] border border-border-low bg-panel/80 p-7 backdrop-blur">
          <div className="mb-5 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-signal/[0.12] px-3 py-1 text-sm font-medium text-signal">
              <span className="h-1.5 w-1.5 rounded-full bg-signal" />
              Ambiguity score 0.78 — High
            </span>
          </div>
          <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">Original resolution text</p>
          <blockquote className="rounded-xl border border-signal/25 bg-signal/[0.05] px-5 py-4 text-base leading-7 text-foreground">
            Resolves Yes if the U.S. economy experiences a recession in 2026.
          </blockquote>
          <div className="mt-5 space-y-2.5">
            <p className="text-xs uppercase tracking-[0.20em] text-muted">Identified issues</p>
            {BEFORE_ISSUES.map((issue) => (
              <div key={issue} className="flex gap-2 text-base text-muted">
                <span className="mt-0.5 shrink-0 text-signal">✕</span>
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>

        {/* AFTER */}
        <div className="card-lift rounded-[2rem] border border-border-low bg-panel/80 p-7 backdrop-blur ring-1 ring-foreground/10">
          <div className="mb-5 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/10 px-3 py-1 text-sm font-medium text-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-foreground" />
              Oracle clarification — auto-published
            </span>
          </div>
          <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">Suggested resolution text</p>
          <blockquote className="rounded-xl border border-border-low bg-card px-5 py-4 text-base leading-7 text-foreground">
            Resolves Yes if the BEA advance GDP estimate shows two consecutive quarters of negative
            real GDP growth in 2026, with Q1 2026 as the earliest qualifying quarter. An NBER
            recession declaration alone is not sufficient. Later revisions to the advance estimate
            are not binding.
          </blockquote>
          <div className="mt-5 space-y-2.5">
            <p className="text-xs uppercase tracking-[0.20em] text-muted">Clarifications applied</p>
            {AFTER_FIXES.map((fix) => (
              <div key={fix} className="flex gap-2 text-base text-muted">
                <span className="mt-0.5 shrink-0 text-foreground">✓</span>
                <span>{fix}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-[1.6rem] border border-border-low bg-card/60 p-6">
        <p className="text-xs uppercase tracking-[0.22em] text-muted">Oracle reasoning excerpt (illustrative)</p>
        <p className="mt-3 text-base leading-7 text-muted">
          "The term 'recession' is undefined in the contract text. The NBER and BEA use materially
          different standards — the NBER can declare a recession without two consecutive negative
          GDP quarters, and the BEA advance estimate is frequently revised. A trader who holds Yes
          because NBER declares a recession may win or lose depending on which standard the resolver
          applies, creating a dispute surface that is entirely about resolver behavior rather than
          the underlying event. Ambiguity score: 0.78."
        </p>
        <p className="mt-3 text-sm text-muted/60">Based on Gemini market #4020 — illustrative oracle output.</p>
      </div>
    </section>
  );
}

function FooterStrip() {
  return (
    <footer className="border-t border-border-low">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-8 sm:px-8 lg:px-10">
        <p className="text-xs text-muted">The Oracle's Wakeup Call — prediction market clarification</p>
        <p className="text-xs text-muted">AI analysis · Human review · Audit trace</p>
      </div>
    </footer>
  );
}

function PublicConsole() {
  const initialSession = useMemo(() => loadStoredSession(PUBLIC_SESSION_STORAGE_KEY), []);
  const [draftApiBaseUrl, setDraftApiBaseUrl] = useState(initialSession.apiBaseUrl);
  const [apiBaseUrl, setApiBaseUrl] = useState(initialSession.apiBaseUrl);
  const [draftEventId, setDraftEventId] = useState("4020");
  const [draftQuestion, setDraftQuestion] = useState(
    "If the NBER formally declares a recession before the deadline but no two consecutive quarters of negative GDP appear in the BEA advance estimates, does this market resolve Yes or No?"
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [intakeState, setIntakeState] = useState<IntakeResponseState | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  function savePublicApiBaseUrl(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextSession = {
      apiBaseUrl: draftApiBaseUrl.trim().replace(/\/+$/, ""),
      reviewerToken: ""
    };

    saveStoredSession(PUBLIC_SESSION_STORAGE_KEY, nextSession);
    setApiBaseUrl(nextSession.apiBaseUrl);
    setIsSettingsOpen(false);
  }

  async function requestChallenge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!apiBaseUrl.trim()) {
      setIntakeState({
        kind: "error",
        eventId: draftEventId.trim(),
        message: "Set the backend API base URL first."
      });
      return;
    }

    setIsSubmitting(true);
    setIntakeState(null);

    try {
      const endpoint = new URL(
        `/api/clarify/${encodeURIComponent(draftEventId.trim())}`,
        apiBaseUrl
      );
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          question: draftQuestion.trim()
        })
      });
      const payload = await response.json();

      if (response.status === 402) {
        setIntakeState({
          kind: "payment_required",
          eventId: draftEventId.trim(),
          payload
        });
        return;
      }

      if (response.ok) {
        setIntakeState({
          kind: "accepted",
          eventId: draftEventId.trim(),
          payload
        });
        return;
      }

      setIntakeState({
        kind: "error",
        eventId: draftEventId.trim(),
        message: payload?.error?.message ?? "The intake request could not be completed."
      });
    } catch (error) {
      setIntakeState({
        kind: "error",
        eventId: draftEventId.trim(),
        message: error instanceof Error ? error.message : "Network error."
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg1 text-foreground">
      {isSettingsOpen ? (
        <SettingsFlyout
          description="Choose which backend this intake form should use for clarification requests."
          onClose={() => setIsSettingsOpen(false)}
          title="Connection"
        >
          <form className="grid gap-4" onSubmit={savePublicApiBaseUrl}>
            <label className="grid gap-2 text-sm">
              <span className="text-muted">Backend API base URL</span>
              <input
                className="rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                onChange={(event) => setDraftApiBaseUrl(event.target.value)}
                placeholder="http://127.0.0.1:3000"
                value={draftApiBaseUrl}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                className="rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background transition hover:translate-y-[-1px]"
                disabled={!draftApiBaseUrl.trim()}
                type="submit"
              >
                Save endpoint
              </button>
              {apiBaseUrl ? (
                <span className="rounded-full border border-border-low px-4 py-3 text-xs uppercase tracking-[0.16em] text-muted">
                  {apiBaseUrl}
                </span>
              ) : null}
            </div>
          </form>
        </SettingsFlyout>
      ) : null}

      <NavBar onOpenSettings={() => setIsSettingsOpen(true)} contextLink={{ href: "/reviewer", label: "Reviewer desk" }} />
      <PublicHero />
      <HowItWorksStrip />
      <BeforeAfterDemo />

      <section id="intake" className="border-t border-border-low">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
          <div className="grid gap-10 lg:grid-cols-[1fr_400px]">
            <div>
              <p className="text-xs uppercase tracking-[0.30em] text-muted">Try it now</p>
              <h2 className="mt-2 font-display text-[clamp(2rem,4vw,3.2rem)] leading-none text-foreground">
                Submit a real clarification request
              </h2>
              <p className="mt-4 max-w-xl text-base leading-7 text-muted">
                Point this form at any running backend. The request is processed
                live — you will see the payment challenge or acceptance state below.
              </p>
              <div className="mt-8 rounded-[2rem] border border-border-low bg-panel/85 p-6 shadow-[0_24px_80px_-48px_rgba(4,13,22,0.45)] backdrop-blur">
                <form className="grid gap-4" onSubmit={requestChallenge}>
                  <label className="grid gap-2 text-base">
                    <span className="text-muted">Event ID</span>
                    <input
                      className="rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                      onChange={(event) => setDraftEventId(event.target.value)}
                      value={draftEventId}
                    />
                  </label>
                  <label className="grid gap-2 text-base">
                    <span className="text-muted">Clarification question</span>
                    <textarea
                      className="min-h-32 rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                      onChange={(event) => setDraftQuestion(event.target.value)}
                      value={draftQuestion}
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="rounded-full bg-foreground px-5 py-3.5 text-base font-medium text-background transition hover:translate-y-[-1px] disabled:opacity-60"
                      disabled={isSubmitting}
                      type="submit"
                    >
                      {isSubmitting ? "Requesting…" : "Submit request"}
                    </button>
                    <span className="rounded-full border border-border-low px-4 py-3 text-xs uppercase tracking-[0.16em] text-muted">
                      Live or upcoming markets
                    </span>
                  </div>
                </form>

                {intakeState ? (
                  <div className="mt-5 rounded-[1.6rem] border border-border-low bg-card p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-muted">
                      Latest response for {intakeState.eventId}
                    </p>
                    {intakeState.kind === "payment_required" ? (
                      <div className="mt-4 space-y-4">
                        <p className="text-2xl font-semibold text-foreground">Payment required</p>
                        {intakeState.payload.paymentRequirements?.map((requirement, index) => (
                          <div
                            key={`${requirement.network ?? "network"}-${index}`}
                            className="rounded-2xl border border-border-low bg-bg1/80 p-4"
                          >
                            <p className="text-base text-foreground">
                              {requirement.description ?? "Clarification payment request"}
                            </p>
                            <p className="mt-2 text-base text-muted">
                              {requirement.assetSymbol === "USDC"
                                ? (Number(requirement.amount) / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
                                : requirement.amount}{" "}
                              {requirement.assetSymbol} on {requirement.network}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {intakeState.kind === "accepted" ? (
                      <div className="mt-4 space-y-3">
                        <p className="text-2xl font-semibold text-foreground">Request accepted</p>
                        <p className="text-base text-muted">
                          Clarification ID {intakeState.payload.clarificationId ?? "pending"} with
                          status {intakeState.payload.status ?? "processing"}.
                        </p>
                      </div>
                    ) : null}
                    {intakeState.kind === "error" ? (
                      <div className="mt-4 space-y-3">
                        <p className="text-2xl font-semibold text-foreground">Request failed</p>
                        <p className="text-base text-muted">{intakeState.message}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="space-y-4 lg:pt-24">
              <div className="rounded-[1.6rem] border border-border-low bg-panel/80 p-6 backdrop-blur">
                <p className="text-xs uppercase tracking-[0.22em] text-muted">What happens next</p>
                <ol className="mt-4 space-y-4">
                  {(
                    [
                      "A payment challenge for $1 is returned immediately",
                      "On payment, the oracle wakes — LLM analysis runs automatically",
                      "A clarification note is published with the ambiguity score and reasoning",
                      "A light suggested edit is included if the wording itself needs it"
                    ] as const
                  ).map((step, i) => (
                    <li key={i} className="flex gap-3 text-base leading-6 text-muted">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-low text-sm font-medium text-foreground">
                        {i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </div>
      </section>

      <FooterStrip />
    </div>
  );
}

export default function App() {
  if (window.location.pathname.startsWith("/reviewer")) {
    return <ReviewerConsole />;
  }

  return <PublicConsole />;
}
