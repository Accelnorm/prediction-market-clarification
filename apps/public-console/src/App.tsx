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

function SectionCard({
  eyebrow,
  title,
  children,
  actions
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-[2rem] border border-border-low bg-panel/85 p-6 shadow-[0_24px_80px_-48px_rgba(4,13,22,0.6)] backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-low pb-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.26em] text-muted">{eyebrow}</p>
          <h2 className="font-display text-[clamp(1.4rem,2vw,2rem)] leading-none text-foreground">
            {title}
          </h2>
        </div>
        {actions}
      </div>
      <div className="mt-5">{children}</div>
    </section>
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
    <div className="min-h-screen bg-bg1 text-foreground">
      <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10">
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
        <header className="grid gap-6 border-b border-border-low pb-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <p className="pt-1 text-xs uppercase tracking-[0.34em] text-muted">Review Desk</p>
              <button
                aria-label="Open settings"
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-border-low bg-panel/80 text-muted transition hover:text-foreground"
                onClick={() => setIsSettingsOpen(true)}
                type="button"
              >
                <SettingsIcon />
              </button>
            </div>
            <h1 className="font-display text-[clamp(3rem,8vw,6.6rem)] leading-[0.9] text-foreground">
              Signal
              <br />
              Market Review
            </h1>
            <p className="max-w-2xl text-base leading-7 text-muted sm:text-lg">
              Review live clarification requests and screen upcoming markets before launch.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <div className="rounded-[1.6rem] border border-border-low bg-panel/80 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Surface</p>
              <p className="mt-3 text-3xl font-semibold text-foreground">
                {reviewerSurface === "prelaunch" ? "Upcoming" : "Live"}
              </p>
            </div>
            <div className="rounded-[1.6rem] border border-border-low bg-panel/80 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Unscanned Upcoming</p>
              <p className="mt-3 text-3xl font-semibold text-foreground">{openCount}</p>
            </div>
            <div className="rounded-[1.6rem] border border-border-low bg-panel/80 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Live Attention</p>
              <p className="mt-3 text-3xl font-semibold text-foreground">{liveNeedsAttention}</p>
            </div>
          </div>
        </header>

        <main className="mt-8 grid gap-6 xl:grid-cols-[0.88fr_1.12fr]">
          <div className="space-y-6">
            <SectionCard eyebrow="Overview" title="What this desk is for">
              <div className="grid gap-4">
                <div className="rounded-[1.6rem] border border-border-low bg-card/70 p-4">
                  <p className="text-sm font-medium text-foreground">Live clarifications</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Review paid clarification requests for Gemini prediction markets,
                    including ambiguity, funding, timing, and final wording.
                  </p>
                </div>
                <div className="rounded-[1.6rem] border border-border-low bg-card/70 p-4">
                  <p className="text-sm font-medium text-foreground">Upcoming review</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Screen markets before trading starts so unclear resolution text
                    and contract structure can be caught early.
                  </p>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Modes"
              title="Move between live clarifications and upcoming review"
              actions={
                reviewerSurface === "prelaunch" && session.apiBaseUrl ? (
                  <button
                    className="rounded-full border border-border-low px-4 py-2 text-sm text-muted transition hover:text-foreground disabled:opacity-60"
                    disabled={isPrelaunchScanAllRunning}
                    onClick={runPrelaunchScanAll}
                    type="button"
                  >
                    {isPrelaunchScanAllRunning ? "Scanning…" : "Scan all upcoming"}
                  </button>
                ) : null
              }
            >
              <div className="space-y-4">
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
                {reviewerSurface === "active" ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={`rounded-full px-3 py-2 text-sm transition ${
                        activeFilter === "all"
                          ? "bg-foreground text-background"
                          : "border border-border-low text-muted"
                      }`}
                      onClick={() => setActiveFilter("all")}
                      type="button"
                    >
                      All
                    </button>
                    {filters.map((filter) => (
                      <button
                        key={filter.key}
                        className={`rounded-full px-3 py-2 text-sm transition ${
                          activeFilter === filter.key
                            ? "bg-foreground text-background"
                            : "border border-border-low text-muted"
                        }`}
                        onClick={() => setActiveFilter(filter.key)}
                        type="button"
                      >
                        {filter.label} ({filter.count})
                      </button>
                    ))}
                  </div>
                ) : availableCategories.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {availableCategories.slice(0, 8).map((category) => (
                      <span
                        key={category}
                        className="rounded-full border border-border-low px-3 py-2 text-xs uppercase tracking-[0.16em] text-muted"
                      >
                        {category}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Queue"
              title={
                reviewerSurface === "prelaunch"
                  ? "Upcoming markets waiting for editorial review"
                  : "Live clarification operations"
              }
            >
              {!session.apiBaseUrl || !session.reviewerToken ? (
                <div className="rounded-[1.6rem] border border-dashed border-border-low bg-card/60 p-5 text-sm leading-6 text-muted">
                  Add reviewer credentials to load queue data. The interface stays closed
                  until the token is present.
                </div>
              ) : null}

              {reviewerSurface === "active" && isLoading ? (
                <div className="text-sm text-muted">Loading live queue…</div>
              ) : null}
              {reviewerSurface === "prelaunch" && isPrelaunchLoading ? (
                <div className="text-sm text-muted">Loading upcoming queue…</div>
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
                <div className="grid gap-4">
                  {activeQueue.map((item) => (
                    <article
                      key={item.eventId}
                      className={`rounded-[1.6rem] border p-5 transition ${
                        item.latestClarificationId &&
                        item.latestClarificationId === selectedClarificationId
                          ? "border-foreground bg-card shadow-[0_18px_50px_-35px_rgba(4,13,22,0.9)]"
                          : "border-border-low bg-card/70"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-2">
                          <p className="text-xs uppercase tracking-[0.2em] text-muted">
                            {item.eventId}
                          </p>
                          <h3 className="text-xl font-semibold text-foreground">
                            {item.marketTitle}
                          </h3>
                          <div className="flex flex-wrap gap-2">
                            {item.queueStates.map((state) => (
                              <span
                                key={state}
                                className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-muted"
                              >
                                {formatQueueStateLabel(state)}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-xs uppercase tracking-[0.18em] text-muted">
                            Ambiguity
                          </p>
                          <p className="mt-2 text-3xl font-semibold text-foreground">
                            {formatAmbiguityScore(item.ambiguityScore)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">Funding</p>
                          <p className="mt-2 text-sm text-foreground">
                            {item.fundingProgress.raisedAmount}/{item.fundingProgress.targetAmount}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">
                            Review window
                          </p>
                          <p className="mt-2 text-sm text-foreground">
                            {Math.round(item.reviewWindow.review_window_secs / 3600)}h
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">Ends</p>
                          <p className="mt-2 text-sm text-foreground">
                            {formatTimestamp(item.endTime)}
                          </p>
                        </div>
                      </div>
                      <p className="mt-4 text-sm leading-6 text-muted">
                        {item.reviewWindow.review_window_reason}
                      </p>
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-low pt-4">
                        <span className="text-xs uppercase tracking-[0.16em] text-muted">
                          {item.latestClarificationId
                            ? `Latest ${item.latestClarificationId}`
                            : "Waiting for first paid clarification"}
                        </span>
                        <button
                          className="rounded-full border border-border-low px-4 py-2 text-sm text-muted transition hover:text-foreground disabled:opacity-50"
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
                <div className="grid gap-4">
                  {prelaunchQueue.map((item) => (
                    <article
                      key={item.eventId}
                      className={`rounded-[1.6rem] border p-5 transition ${
                        item.eventId === selectedPrelaunchEventId
                          ? "border-foreground bg-card shadow-[0_18px_50px_-35px_rgba(4,13,22,0.9)]"
                          : "border-border-low bg-card/70"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-2">
                          <p className="text-xs uppercase tracking-[0.2em] text-muted">
                            {item.eventId} {item.ticker ? `• ${item.ticker}` : ""}
                          </p>
                          <h3 className="text-xl font-semibold text-foreground">
                            {item.marketTitle}
                          </h3>
                          <div className="flex flex-wrap gap-2">
                            <span className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-muted">
                              {item.category ?? "Uncategorized"}
                            </span>
                            <span className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-muted">
                              {item.status ?? "upcoming"}
                            </span>
                            {item.needsScan ? (
                              <span className="rounded-full border border-border-low px-3 py-1 text-xs uppercase tracking-[0.16em] text-signal">
                                Needs scan
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-xs uppercase tracking-[0.18em] text-muted">
                            Editorial temperature
                          </p>
                          <p className="mt-2 text-xl font-semibold text-foreground">
                            {getReviewTemperature(item.ambiguityScore)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">Starts</p>
                          <p className="mt-2 text-sm text-foreground">
                            {formatOptionalTimestamp(item.startsAt)}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">Ends</p>
                          <p className="mt-2 text-sm text-foreground">
                            {formatTimestamp(item.endTime)}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border-low bg-bg1/80 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted">
                            Contracts
                          </p>
                          <p className="mt-2 text-sm text-foreground">{item.contracts.length}</p>
                        </div>
                      </div>
                      <p className="mt-4 text-sm leading-6 text-muted">
                        {item.reviewWindow.review_window_reason}
                      </p>
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-low pt-4">
                        <span className="text-xs uppercase tracking-[0.16em] text-muted">
                          {item.latestScanId ? `Latest ${item.latestScanId}` : "No stored scan"}
                        </span>
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded-full border border-border-low px-4 py-2 text-sm text-muted transition hover:text-foreground"
                            onClick={() => setSelectedPrelaunchEventId(item.eventId)}
                            type="button"
                          >
                            Inspect
                          </button>
                          <button
                            className="rounded-full bg-foreground px-4 py-2 text-sm text-background transition disabled:opacity-60"
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
            </SectionCard>

          </div>

          <div className="space-y-6">
            <SectionCard
              eyebrow="Detail"
              title={
                reviewerSurface === "prelaunch"
                  ? "Upcoming market inspection"
                  : "Clarification dossier"
              }
            >
              {reviewerSurface === "active" && isDetailLoading ? (
                <div className="text-sm text-muted">Loading clarification detail…</div>
              ) : null}
              {reviewerSurface === "prelaunch" && isPrelaunchDetailLoading ? (
                <div className="text-sm text-muted">Loading upcoming market detail…</div>
              ) : null}
              {reviewerSurface === "active" && detailErrorMessage ? (
                <div className="rounded-[1.6rem] border border-border-low bg-card p-4 text-sm text-muted">
                  {detailErrorMessage}
                </div>
              ) : null}
              {reviewerSurface === "prelaunch" && prelaunchDetailErrorMessage ? (
                <div className="rounded-[1.6rem] border border-border-low bg-card p-4 text-sm text-muted">
                  {prelaunchDetailErrorMessage}
                </div>
              ) : null}

              {reviewerSurface === "active" && !detail && !isDetailLoading && !detailErrorMessage ? (
                <div className="rounded-[1.6rem] border border-dashed border-border-low bg-card/60 p-5 text-sm leading-6 text-muted">
                  Select a live clarification to inspect wording, funding history, artifact output,
                  and the current review window.
                </div>
              ) : null}

              {reviewerSurface === "prelaunch" &&
              !prelaunchDetail &&
              !isPrelaunchDetailLoading &&
              !prelaunchDetailErrorMessage ? (
                <div className="rounded-[1.6rem] border border-dashed border-border-low bg-card/60 p-5 text-sm leading-6 text-muted">
                  Select an upcoming market to inspect contract structure, category context, and
                  the latest ambiguity scan.
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
            </SectionCard>
          </div>
        </main>
      </div>
    </div>
  );
}

function PublicConsole() {
  const initialSession = useMemo(() => loadStoredSession(PUBLIC_SESSION_STORAGE_KEY), []);
  const [draftApiBaseUrl, setDraftApiBaseUrl] = useState(initialSession.apiBaseUrl);
  const [apiBaseUrl, setApiBaseUrl] = useState(initialSession.apiBaseUrl);
  const [draftRequesterId, setDraftRequesterId] = useState("phase1_tester");
  const [draftEventId, setDraftEventId] = useState("gm_sol_above_500");
  const [draftQuestion, setDraftQuestion] = useState(
    "If trading opens later than planned, does the same end timestamp still control resolution?"
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
          requesterId: draftRequesterId.trim() || "phase1_tester",
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
      <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10">
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
        <header className="grid gap-6 border-b border-border-low pb-10 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <p className="pt-1 text-xs uppercase tracking-[0.34em] text-muted">
                Clarification Network
              </p>
              <button
                aria-label="Open settings"
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-border-low bg-panel/80 text-muted transition hover:text-foreground"
                onClick={() => setIsSettingsOpen(true)}
                type="button"
              >
                <SettingsIcon />
              </button>
            </div>
            <h1 className="font-display text-[clamp(3.2rem,8vw,7rem)] leading-[0.88] text-foreground">
              Markets need
              <br />
              editorial truth
            </h1>
            <p className="max-w-2xl text-base leading-7 text-muted sm:text-lg">
              Ask for clarification on Gemini prediction markets, track the payment
              challenge, and route disputed market wording into review.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                className="rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background transition hover:translate-y-[-1px]"
                href="/reviewer"
              >
                Open reviewer desk
              </a>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <div className="rounded-[1.6rem] border border-border-low bg-panel/80 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Requests</p>
              <p className="mt-3 text-3xl font-semibold text-foreground">Paid</p>
            </div>
            <div className="rounded-[1.6rem] border border-border-low bg-panel/80 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Upcoming markets</p>
              <p className="mt-3 text-lg font-semibold text-foreground">Reviewable</p>
            </div>
            <div className="rounded-[1.6rem] border border-border-low bg-panel/80 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-muted">Decisions</p>
              <p className="mt-3 text-lg font-semibold text-foreground">Tracked</p>
            </div>
          </div>
        </header>

        <main className="mt-8 grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-6">
            <SectionCard eyebrow="Clarification intake" title="Request a clarification">
              <p className="mb-4 max-w-2xl text-sm leading-6 text-muted">
                Use this form when a Gemini prediction market needs clearer resolution
                criteria, timing, or source-of-truth wording.
              </p>
              <form className="grid gap-4" onSubmit={requestChallenge}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-2 text-sm">
                    <span className="text-muted">Requester ID</span>
                    <input
                      className="rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                      onChange={(event) => setDraftRequesterId(event.target.value)}
                      value={draftRequesterId}
                    />
                  </label>
                  <label className="grid gap-2 text-sm">
                    <span className="text-muted">Event ID</span>
                    <input
                      className="rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                      onChange={(event) => setDraftEventId(event.target.value)}
                      value={draftEventId}
                    />
                  </label>
                </div>
                <label className="grid gap-2 text-sm">
                  <span className="text-muted">Clarification question</span>
                  <textarea
                    className="min-h-32 rounded-2xl border border-border-low bg-card px-4 py-3 outline-none transition focus:border-border-strong"
                    onChange={(event) => setDraftQuestion(event.target.value)}
                    value={draftQuestion}
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <button
                    className="rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background transition hover:translate-y-[-1px] disabled:opacity-60"
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
                      <p className="text-2xl font-semibold text-foreground">
                        Payment required
                      </p>
                      {intakeState.payload.paymentRequirements?.map((requirement, index) => (
                        <div
                          key={`${requirement.network ?? "network"}-${index}`}
                          className="rounded-2xl border border-border-low bg-bg1/80 p-4"
                        >
                          <p className="text-sm text-foreground">
                            {requirement.description ?? "Clarification payment request"}
                          </p>
                          <p className="mt-2 text-sm text-muted">
                            {requirement.amount} {requirement.assetSymbol} on{" "}
                            {requirement.network}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {intakeState.kind === "accepted" ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-2xl font-semibold text-foreground">
                        Request accepted
                      </p>
                      <p className="text-sm text-muted">
                        Clarification ID {intakeState.payload.clarificationId ?? "pending"} with status{" "}
                        {intakeState.payload.status ?? "processing"}.
                      </p>
                    </div>
                  ) : null}
                  {intakeState.kind === "error" ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-2xl font-semibold text-foreground">Request failed</p>
                      <p className="text-sm text-muted">{intakeState.message}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </SectionCard>
          </div>

          <div className="space-y-6">
            <SectionCard eyebrow="Features" title="What each part does">
              <div className="grid gap-4">
                <div className="rounded-[1.6rem] border border-border-low bg-card p-5">
                  <p className="text-lg font-semibold text-foreground">Clarification requests</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Submit a question about how a Gemini market should be interpreted.
                    The backend returns the payment challenge required to open the request.
                  </p>
                </div>
                <div className="rounded-[1.6rem] border border-border-low bg-card p-5">
                  <p className="text-lg font-semibold text-foreground">Reviewer desk</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Internal reviewers can inspect live requests, review upcoming markets,
                    and trigger ambiguity scans before launch.
                  </p>
                </div>
              </div>
            </SectionCard>

          </div>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  if (window.location.pathname.startsWith("/reviewer")) {
    return <ReviewerConsole />;
  }

  return <PublicConsole />;
}
