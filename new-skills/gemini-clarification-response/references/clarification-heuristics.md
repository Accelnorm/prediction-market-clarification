# Gemini Clarification Heuristics

## Use This Reference

Load this file when answering a paid clarification request about Gemini market wording, eligible evidence, or settlement edge cases.

## Core Standard

A good clarification answer should make the contract resolvable by an uninvolved third party from the written rules and named public evidence alone.

If the answer depends on guessing what the resolver will prefer later, the market is still ambiguous.

## Clarification Checks

### 1. Source binding

Ask which exact source is authoritative.

Flag:

- multiple acceptable sources with no priority order
- vague fallbacks such as `credible reports`
- price questions that do not specify the qualifying Gemini feed or publication

Rewrite pattern:

- bind the market to one named source and one explicit fallback hierarchy if absolutely necessary

### 2. Qualifying print or measurement rule

Ask what specific observation counts.

Flag:

- auctions versus continuous order-book trades
- indicative prices versus executed trades
- first print versus any print versus closing print
- revisable statistics with no binding release or vintage

Rewrite pattern:

- state the exact qualifying trade, release, or measurement event in observable terms

### 3. Time boundary precision

Ask when the clock stops and under which timezone.

Flag:

- `before year end`
- `by end of day`
- missing timezone
- unclear inclusive or exclusive deadline semantics

Rewrite pattern:

- use an exact timestamp, timezone, and inclusive or exclusive condition

### 4. Conditional completeness

Ask whether every branch of the contract resolves deterministically.

Flag:

- conditions that never occur
- successor entities or substitutions
- announcements that are partial, preliminary, or later withdrawn

Rewrite pattern:

- define what happens when the triggering condition fails or remains incomplete

### 5. Intersubjective or discretionary language

Ask whether the contract relies on judgment words instead of observable evidence.

Flag:

- `official`
- `significant`
- `material`
- `credible`
- `substantial`

Rewrite pattern:

- replace judgment words with measurable or source-bound criteria

## Answer Shape

When the market is ambiguous:

- `reasoning` should explain why the user's question exposes a real contract gap
- `ambiguity_summary` should name the missing binding detail
- `suggested_market_text` should fix that detail directly
- `suggested_note` should tell the operator exactly what to lock down

When the market is already clear:

- explain the binding clause that answers the user's question
- keep the suggested rewrite minimal
- use a lower ambiguity score
