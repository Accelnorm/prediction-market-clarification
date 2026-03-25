---
name: issue-clarification-response
description: Answer a paid Gemini prediction-market clarification request by turning ambiguous market wording into a deterministic interpretation. Use when an LLM must respond to a concrete clarification question for an active or upcoming Gemini market, explain the highest-risk ambiguity, assign an ambiguity score, cite the operative clause, propose tighter market text, and write an operator note that makes the resolution rule binding.
---

# Issue Clarification Response

## Overview

Answer the user's clarification question as a contract-resolution task. Focus on whether the written market rules and named evidence are sufficient for a neutral third party to resolve the market without discretionary judgment.

Return output with these exact keys:

- `verdict`: `clear` or `needs_clarification`
- `llm_status`: `completed`
- `reasoning`
- `cited_clause`
- `ambiguity_score`
- `ambiguity_summary`
- `suggested_market_text`: optional when `verdict` is `clear`
- `suggested_note`: optional when `verdict` is `clear`

## Response Workflow

1. Read the user's question together with the title, resolution text, close time, and any source hints in the market payload. If `termsContent` is non-null, treat it as the authoritative contract terms that supplement the resolution text — use it to resolve questions about index methodology, fallback procedures, or any detail not explicit in the resolution text. A market is clear if the resolution text and terms together fully specify the source, threshold, and timing, even if those details appear only in the terms.
2. Identify the decisive ambiguity behind the question. Prefer the clause most likely to create a bad settlement, post-resolution dispute, or "bet on resolver" behavior.
3. Answer from the written contract, not from assumed platform policy. If the contract does not bind the key detail, treat that as ambiguity.
4. Distinguish event uncertainty from contract ambiguity. Hard-to-predict events can still be clear contracts.
5. Propose the minimal deterministic fix. Preserve the market's intended question while making the source, timing rule, print rule, or conditional branch explicit.
6. Write an operator note that states exactly what must be made binding.

## What To Prioritize

- Missing or underspecified Gemini source selection
- Unclear trade-print qualification such as auctions, indicative prices, crossing sessions, or fallback feeds
- Missing timestamp, timezone, or inclusive versus exclusive deadline semantics
- Revisable measurements or competing publications with no named binding release
- Subjective fallback language such as `official`, `credible`, `material`, or `significant`
- Conditional branches that fail to say what happens if the condition never occurs

## Output Guidance

- Keep `reasoning` grounded in the market text and the user's question.
- Keep `cited_clause` narrow. Quote or restate the clause that creates the ambiguity.
- Use `ambiguity_score` to reflect contract precision, not forecasting difficulty.
- Make `suggested_market_text` executable as a resolution rule. Name the binding source, threshold, and time boundary explicitly.
- Make `suggested_note` useful to an operator or reviewer. State the single policy choice or edge-case rule that should be locked in.
- If the market is already precise enough, return `clear`.
- Only include `suggested_market_text` or `suggested_note` for a `clear` verdict when a small wording tweak is still useful.

## Scoring Bands

- `0.00-0.24`: clear contract, only cosmetic tightening
- `0.25-0.49`: minor ambiguity, probably still resolvable
- `0.50-0.69`: material ambiguity, clarification warranted
- `0.70-0.84`: high dispute risk if left unchanged
- `0.85-1.00`: severe ambiguity, likely pricing resolver behavior instead of event reality

Default `verdict` to `needs_clarification` at `0.50` or above.

## Reference

Read [references/clarification-heuristics.md](references/clarification-heuristics.md) for ambiguity categories, response heuristics, and deterministic rewrite patterns for clarification answers.
