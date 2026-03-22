import { expect, test, type Page } from "@playwright/test";

const validSession = {
  apiBaseUrl: "http://127.0.0.1:4173",
  reviewerToken: "reviewer-secret",
};

const queueItems = [
  {
    eventId: "gm_btc_above_100k",
    latestClarificationId: "clar_review_001",
    marketTitle: "Will BTC trade above $100,000 before year end?",
    endTime: "2026-12-31T23:59:00.000Z",
    ambiguityScore: 0.82,
    fundingProgress: {
      raisedAmount: "80.00",
      targetAmount: "100.00",
      contributorCount: 4,
      fundingState: "funding_in_progress",
    },
    reviewWindow: {
      review_window_secs: 21600,
      review_window_reason:
        "High ambiguity near expiry reduced the base review window to six hours.",
      time_to_end_bucket: "between_12h_and_48h",
      activity_signal: "high",
      ambiguity_score: 0.82,
    },
    voteStatus: "awaiting_panel_vote",
    queueStates: ["high_ambiguity", "awaiting_panel_vote", "funded"],
  },
  {
    eventId: "gm_sol_above_500",
    latestClarificationId: "clar_review_002",
    marketTitle: "Will SOL trade above $500 before year end?",
    endTime: "2026-09-01T15:00:00.000Z",
    ambiguityScore: 0.38,
    fundingProgress: {
      raisedAmount: "0.00",
      targetAmount: "100.00",
      contributorCount: 0,
      fundingState: "unfunded",
    },
    reviewWindow: {
      review_window_secs: 86400,
      review_window_reason:
        "Base window set from gt_72h time-to-end bucket. Final window 86400 seconds within policy bounds.",
      time_to_end_bucket: "gt_72h",
      activity_signal: "normal",
      ambiguity_score: 0.38,
    },
    voteStatus: "not_started",
    queueStates: ["needs_scan"],
  },
];

const filters = [
  { key: "needs_scan", label: "Needs Scan", count: 1 },
  { key: "high_ambiguity", label: "High Ambiguity", count: 1 },
  { key: "funded", label: "Funded", count: 1 },
  { key: "near_expiry", label: "Near Expiry", count: 0 },
  { key: "awaiting_panel_vote", label: "Awaiting Panel Vote", count: 1 },
  { key: "finalized", label: "Finalized", count: 0 },
];

const detailPayload = {
  ok: true,
  clarification: {
    clarificationId: "clar_review_001",
    status: "completed",
    eventId: "gm_btc_above_100k",
    question: "Should only Gemini BTC/USD spot trades count?",
    createdAt: "2026-03-21T20:35:00.000Z",
    updatedAt: "2026-03-21T20:40:00.000Z",
    llmOutput: {
      verdict: "AMBIGUOUS",
      llm_status: "needs_human",
      reasoning:
        "The market text does not explicitly exclude auction prints or external venues.",
      cited_clause:
        "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
      ambiguity_score: 0.79,
      ambiguity_summary:
        "The resolution source is underspecified for venue scope and print selection.",
      suggested_market_text:
        "Resolves YES if the Gemini BTC/USD spot market trades above $100,000 on the standard order book before December 31 2026 23:59 UTC.",
      suggested_note:
        "Use standard Gemini BTC/USD spot prints only; auction and external venue prices do not count.",
    },
    llmTrace: {
      promptTemplateVersion: "clarification-v2",
      modelId: "claude-3-7-sonnet",
      requestedAt: "2026-03-21T20:35:03.000Z",
      processingVersion: "review-pipeline-2026-03-21",
    },
    market: {
      marketId: "gm_btc_above_100k",
      title: "Will BTC trade above $100,000 before year end?",
      resolutionText:
        "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
      endTime: "2026-12-31T23:59:00.000Z",
      slug: "btc-above-100k-2026",
      url: "https://example.com/markets/btc-above-100k-2026",
    },
    funding: {
      raisedAmount: "80.00",
      targetAmount: "100.00",
      contributorCount: 2,
      fundingState: "funding_in_progress",
      history: [
        {
          contributor: "wallet_alpha",
          amount: "50.00",
          timestamp: "2026-03-21T20:37:00.000Z",
          reference: "fund_ref_001",
        },
        {
          contributor: "wallet_beta",
          amount: "30.00",
          timestamp: "2026-03-21T20:36:00.000Z",
          reference: "fund_ref_002",
        },
      ],
    },
    vote: {
      status: "awaiting_panel_vote",
      label: "Awaiting Panel Vote",
      placeholder: true,
      summary: "Off-chain placeholder until panel voting is implemented.",
      updatedAt: "2026-03-21T20:40:00.000Z",
    },
    artifact: {
      cid: "bafyreviewartifact001",
      url: "ipfs://bafyreviewartifact001",
    },
    review_window_secs: 21600,
    review_window_reason:
      "High ambiguity near expiry reduced the base review window to six hours.",
    time_to_end_bucket: "between_12h_and_48h",
    activity_signal: "high",
    ambiguity_score: 0.79,
  },
};

const artifactPayload = {
  ok: true,
  artifact: {
    clarificationId: "clar_review_001",
    eventId: "gm_btc_above_100k",
    marketText:
      "Resolves YES if Gemini BTC/USD prints above $100,000 before December 31 2026 23:59 UTC.",
    suggestedEditedMarketText:
      "Resolves YES if the Gemini BTC/USD spot market trades above $100,000 on the standard order book before December 31 2026 23:59 UTC.",
    clarificationNote:
      "Use standard Gemini BTC/USD spot prints only; auction and external venue prices do not count.",
    generatedAtUtc: "2026-03-21T20:35:04.000Z",
    cid: "bafyreviewartifact001",
    url: "ipfs://bafyreviewartifact001",
  },
};

function buildQueuePayload(activeFilter?: string) {
  const filteredQueue =
    !activeFilter || activeFilter === "all"
      ? queueItems
      : queueItems.filter((item) => item.queueStates.includes(activeFilter));

  return {
    ok: true,
    activeFilter,
    filters,
    queue: filteredQueue,
  };
}

async function installReviewerApiMock(page: Page) {
  await page.route("**/api/reviewer/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reviewerToken = request.headers()["x-reviewer-token"];

    if (reviewerToken !== validSession.reviewerToken) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "REVIEWER_AUTH_REQUIRED",
            message: "Reviewer authentication is required for this route.",
          },
        }),
      });
      return;
    }

    if (url.pathname === "/api/reviewer/queue") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          buildQueuePayload(url.searchParams.get("filter") ?? undefined)
        ),
      });
      return;
    }

    if (url.pathname === "/api/reviewer/clarifications/clar_review_001") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detailPayload),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Mock route not configured.",
        },
      }),
    });
  });

  await page.route("**/api/artifacts/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(artifactPayload),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await installReviewerApiMock(page);
});

test("reviewer route fails closed before credentials are present", async ({
  page,
}) => {
  await page.goto("/reviewer");

  await expect(page.getByTestId("reviewer-session-blocked")).toContainText(
    "Enter reviewer credentials to unlock the queue"
  );
  await expect(page.getByTestId("reviewer-detail-empty")).toContainText(
    "Pick a queue item with a paid clarification"
  );
  await expect(page.getByTestId("reviewer-filter-list")).toContainText(
    "All markets"
  );
});

test("reviewer route renders queue filters and detail records for an authenticated session", async ({
  page,
}) => {
  await page.goto("/reviewer");
  await page.getByLabel("Backend API base URL").fill(validSession.apiBaseUrl);
  await page.getByLabel("Reviewer token").fill(validSession.reviewerToken);
  const loadQueueButton = page.getByRole("button", {
    name: "Load reviewer queue",
  });
  await expect(loadQueueButton).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/reviewer/queue") &&
        response.request().method() === "GET"
    ),
    loadQueueButton.click(),
  ]);

  await expect(page.getByTestId("queue-item-gm_btc_above_100k")).toContainText(
    "Will BTC trade above $100,000 before year end?"
  );
  await expect(page.getByTestId("filter-high_ambiguity")).toContainText(
    "High Ambiguity"
  );

  await page.getByTestId("filter-needs_scan").click();
  await expect(page.getByTestId("queue-item-gm_sol_above_500")).toContainText(
    "Will SOL trade above $500 before year end?"
  );
  await expect(page.getByTestId("queue-item-gm_btc_above_100k")).toHaveCount(0);

  await page.getByTestId("filter-near_expiry").click();
  await expect(page.getByTestId("reviewer-empty-state")).toContainText(
    "No markets match the"
  );

  await page.getByTestId("filter-all").click();
  await page.getByTestId("open-detail-gm_btc_above_100k").click();

  await expect(page.getByTestId("reviewer-detail-panel")).toBeVisible();
  await expect(page.getByTestId("reviewer-market-section")).toContainText(
    "Will BTC trade above $100,000 before year end?"
  );
  await expect(page.getByTestId("reviewer-llm-section")).toContainText(
    "Suggested edited market text"
  );
  await expect(page.getByTestId("reviewer-artifact-section")).toContainText(
    "bafyreviewartifact001"
  );
  await expect(
    page.getByTestId("reviewer-funding-history-section")
  ).toContainText("wallet_alpha");
  await expect(page.getByTestId("reviewer-vote-section")).toContainText(
    "Awaiting Panel Vote"
  );
  await expect(page.getByTestId("reviewer-trace-section")).toContainText(
    "clarification-v2"
  );
});

test("reviewer route shows an auth error when stored credentials are invalid", async ({
  page,
}) => {
  await page.goto("/reviewer");
  await page.getByLabel("Backend API base URL").fill(validSession.apiBaseUrl);
  await page.getByLabel("Reviewer token").fill("bad-token");
  await page.getByRole("button", { name: "Load reviewer queue" }).click();

  await expect(page.getByTestId("reviewer-queue-error")).toContainText(
    "Reviewer authentication is required for this route."
  );
  await expect(page.getByTestId("reviewer-detail-empty")).toContainText(
    "Pick a queue item with a paid clarification"
  );
});
