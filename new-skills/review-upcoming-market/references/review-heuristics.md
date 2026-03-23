# Upcoming Market Review Heuristics

## Use This Reference

Load this file when reviewing an upcoming or proposed prediction market for launch readiness, prelaunch scan output quality, or resolver-risk analysis.

## Primary Question

Can an uninvolved third party resolve the market deterministically from the written rules and named public sources alone?

If not, the market is ambiguous even when the real-world event itself is uncertain.

## Distinguish Outcome Uncertainty From Contract Ambiguity

- Outcome uncertainty: The event is hard to predict, but `Yes` and `No` are still well defined.
- Contract ambiguity: Traders can reasonably disagree about what counts as `Yes`, what source is binding, when the clock stops, or how the resolver will interpret an edge case.

High-quality review should punish contract ambiguity, not mere difficulty.

## Failure Taxonomy

### 1. Linguistic or semantic ambiguity

Flag vague qualifiers, polysemous verbs, and unclear referents.

Examples:

- `significant escalation`
- `official announcement`
- `the bill passes`
- `credible reporting`

Reviewer action:

- Define the qualifier numerically or operationally.
- Replace pronouns and generic nouns with unique entity identifiers.

### 2. Event-definition vagueness

Flag unclear boundaries around what event counts.

Examples:

- What counts as an `invasion`?
- Does a preliminary announcement count as a `deal`?
- Do substitutions or successor entities count?

Reviewer action:

- Write the qualifying event in observable terms.
- Add examples or edge-case exclusions when needed.

### 3. Outcome measurement ambiguity

Flag cases where the metric, publication, or release vintage is not fixed.

Common traps:

- GDP or payrolls without a named estimate
- Price questions without an authoritative feed or print rule
- Multiple acceptable sources with no priority order

Reviewer action:

- Bind resolution to one named source.
- Specify whether the first release, later revision, or latest-as-of date is binding.

### 4. Temporal ambiguity

Flag any missing timestamp, timezone, or boundary rule.

Common traps:

- `by end of day`
- `before Friday`
- no timezone
- unclear `commenced` versus `completed`

Reviewer action:

- Use an exact timestamp and timezone.
- State whether the boundary is inclusive or exclusive.

### 5. Conditionality and dependency ambiguity

Flag unresolved branches in `if A then B` logic.

Common traps:

- The contract never says what happens if `A` does not occur.
- Cross-market dependencies imply another disputed market must resolve first.

Reviewer action:

- Write a full truth table.
- Define the fallback outcome or cancellation condition.

### 6. Aggregation or partition ambiguity

Flag outcome sets that are not mutually exclusive and collectively exhaustive.

Common traps:

- Overlapping answer choices
- Missing a fallback branch
- Price buckets with gaps or overlaps

Reviewer action:

- Redesign the partition so one and only one outcome can resolve true.

### 7. Oracle and resolver fragility

Flag contracts that push too much judgment onto a resolver, governance vote, or vague source fallback.

Common traps:

- `consensus of credible reporting`
- token-vote resolution for intersubjective questions
- weak challenge windows or dispute friction

Reviewer action:

- Reduce resolver discretion in the text.
- Prefer objective, public, authoritative evidence.

### 8. Structural unreliability

This is not always a wording problem, but it matters for review quality.

Common traps:

- thin liquidity
- low participation
- concentrated governance power
- legal uncertainty that can delist or constrain the market

Reviewer action:

- Mention it in reasoning when it changes how the market should be interpreted.
- Do not use it as the only reason to flag a well-specified market.

## Red-Flag Checks

Run these checks before drafting the result:

- Vagueness check: Are there undefined subjective adjectives or nouns?
- Source-binding check: Is there exactly one primary settlement source?
- Revision check: Could the source revise the result later?
- Time-boundary check: Is there an exact timestamp and timezone?
- Branch-completeness check: Are all conditional branches covered?
- Resolver-discretion check: Would a neutral resolver still need judgment?
- Edge-case test: Can you name three plausible edge cases that flip `Yes` or `No`?

If two or more of these fail, the market usually belongs at `0.50+`.

## Scoring Guidance

### 0.00-0.24

The contract is operationally precise. A neutral resolver could settle it from named evidence with little discretion.

### 0.25-0.49

Minor missing detail or wording roughness exists, but the intended payoff mapping is still mostly obvious.

### 0.50-0.69

A material clause is underspecified. Different reasonable readers could trade different interpretations or argue over settlement.

### 0.70-0.84

The market has a serious source, timing, branch, or definition problem that is likely to create dispute, inconsistent precedent, or inaccurate resolution.

### 0.85-1.00

The market is so underspecified that the tradable object is largely a forecast of resolver behavior, governance behavior, or media interpretation rather than the intended event.

## Reviewer Output Pattern

Use this structure mentally even if the calling context wraps it differently:

- `verdict`: `clear` or `needs_clarification`
- `reasoning`: explain the highest-impact issue first
- `cited_clause`: quote or restate the problematic clause
- `ambiguity_score`: numeric score from `0` to `1`
- `ambiguity_summary`: one short sentence
- `suggested_market_text`: minimally sufficient rewrite
- `suggested_note`: operator-facing implementation note

## Rewrite Rules

- Preserve the market's intent. Do not silently change the economic question.
- Prefer minimal edits over full rewrites.
- Replace subjective language with objective criteria.
- Name the authoritative source and any fallback hierarchy explicitly.
- Fix time boundaries with exact timestamps and timezones.
- For revisable data, name the binding release.
- For conditionals, write what happens when the trigger does not occur.

## Good Reviewer Notes

Strong notes usually do one of these:

- name the exact authoritative source
- specify the qualifying print, estimate, or record
- define whether first publication or later revision controls
- clarify inclusive or exclusive time handling
- close an uncovered conditional branch

## High-Risk Phrases

- `credible reports`
- `official confirmation`
- `major outage`
- `substantial increase`
- `announced`
- `approved`
- `first enters`
- `by end of day`

These are not automatically disqualifying, but they should trigger closer review.
