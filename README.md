# Oracle's Wake-Up Call

Prediction-market ambiguity resolution workspace with an off-chain reviewer MVP and a public console.

## Repo Layout

- [apps/offchain-backend](/home/user/gemini-pm/apps/offchain-backend): Node service for market sync, paid clarification creation, reviewer APIs, artifact publishing, funding read models, and off-chain workflow state.
- [apps/public-console](/home/user/gemini-pm/apps/public-console): Vite/React frontend with the `/reviewer` route and Playwright browser coverage.
- [specs](/home/user/gemini-pm/specs): Product and roadmap documents. This is a nested Git repo with its own history and remote.

## Specs

Primary product documents live under [specs](/home/user/gemini-pm/specs):

- [prd.md](/home/user/gemini-pm/specs/prd.md)
- [prd-offchain.json](/home/user/gemini-pm/specs/prd-offchain.json)
- [implementation-roadmap.md](/home/user/gemini-pm/specs/implementation-roadmap.md)
- [solana-program-prd.md](/home/user/gemini-pm/specs/solana-program-prd.md)

`prd-offchain.json` is the checklist used to track reviewer-first MVP completion.

## Validation

Backend:

```bash
cd apps/offchain-backend
npm test
```

Frontend:

```bash
cd apps/public-console
npm run ci
npm run test:e2e
```

The reviewer UI is verified in-browser with Playwright coverage and MCP browser checks against `/reviewer`.
