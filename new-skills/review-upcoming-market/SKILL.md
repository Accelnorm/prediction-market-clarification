---
name: review-upcoming-market
description: Review proposed or upcoming prediction markets for ambiguity, unintelligibility, structural uncertainty, and resolver risk before launch. Use when an agent needs to decide whether a market is clear or needs clarification, identify the highest-risk issue in the market text, assign an ambiguity score, suggest tighter market wording, or draft an operator note for reviewer or prelaunch scan workflows.
---

# Review Upcoming Market

## Overview

Review an upcoming market as a contract, not just a headline. Determine whether a neutral third party could resolve it from the written rules and named public sources alone.

Return output that fits the repo's reviewer scan shape:

- `verdict`: `clear` or `needs_clarification`
- `llm_status`: `completed`
- `reasoning`
- `cited_clause`
- `ambiguity_score`
- `ambiguity_summary`
- `suggested_market_text`
- `suggested_note`

## Review Workflow

1. Extract the operative contract from the title, resolution text, close time, source references, and any fallback language. If `termsContent` is non-null in the market payload, treat it as the authoritative contract terms — use it to resolve questions about index methodology, fallback procedures, or any detail not stated in the resolution text. A market is clear if the resolution text and terms together fully specify the source, threshold, and timing, even if those details appear only in the terms.
2. Identify the single highest-risk issue. Prefer the clause most likely to create a dispute, bad resolution, or "bet on resolver" behavior.
3. Test determinism. Ask whether an uninvolved resolver could settle the market from the written rules plus named evidence without discretionary judgment.
4. Score the ambiguity using the bands below. Do not punish ordinary forecasting difficulty when the contract is precise.
5. Propose the minimal fix. Rewrite only what is required to remove the main ambiguity while preserving the intended question.
6. Write the operator note. State what source, edge-case rule, or missing branch should be made binding.

## Scoring Bands

- `0.00-0.24`: clear enough to monitor
- `0.25-0.49`: minor ambiguity, but likely resolvable
- `0.50-0.69`: materially ambiguous, reviewer follow-up warranted
- `0.70-0.84`: high risk of dispute or inconsistent resolution
- `0.85-1.00`: severe ambiguity, likely pricing resolver behavior rather than event reality

Default `verdict` to `needs_clarification` at `0.50` or above.

## What To Flag First

- Undefined qualifiers such as `significant`, `credible`, `official`, `substantial`, or `material`
- Missing or subjective source hierarchy
- Revisable metrics without a binding release or vintage
- Missing timestamp or timezone, or unclear inclusive or exclusive deadline semantics
- Conditional branches that do not define what happens if the condition fails
- Overlapping or non-exhaustive outcomes in multi-outcome framing
- Rules that depend on discretionary oracle judgment, media consensus, or governance discretion
- Markets where the best interpretation is really a guess about how the resolver will rule

## Output Guidance

- Keep `cited_clause` narrow. Quote or restate the clause creating the problem.
- Keep `ambiguity_summary` short and concrete.
- Make `suggested_market_text` deterministic. Name the source, release, timestamp, timezone, and condition boundaries explicitly.
- Make `suggested_note` useful to an operator. State the binding source, edge-case treatment, or missing branch that must be added.
- If the text is already precise, keep the rewrite small and explain why the market is clear.

## Escalation Boundary

- Use this skill to diagnose and tighten the market text.
- If the review still depends on missing policy, missing source selection, or unresolved Gemini-specific settlement guidance, use [../request-gemini-clarification/SKILL.md](../request-gemini-clarification/SKILL.md).

## Reference

Read [references/review-heuristics.md](references/review-heuristics.md) for the ambiguity taxonomy, red-flag tests, score guidance, and reviewer-specific checks.
