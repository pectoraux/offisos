# Offisos — Construction Operating System

> One shared construction reality model, exposed through familiar professional tools and intelligent workflows.

- **Architecture:** v1.1, FROZEN — see [`spec/architecture.md`](spec/architecture.md) and [`spec/architecture-lock.md`](spec/architecture-lock.md).
- **Current implementation roadmap:** [`spec/roadmap-v1.1.md`](spec/roadmap-v1.1.md).
- **Historical v1.0 backlog:** [`spec/work-items.md`](spec/work-items.md) — retained for historical traceability while the current v1.1 roadmap is maintained separately.
- **Specification package:** [`spec/00-readme.md`](spec/00-readme.md) — architecture, requirements, work items, dependency graph, research plan.
- **Development governance:** [`governance/README.md`](governance/README.md) — the executable work-item lifecycle (state machine, evidence policy, Architect review), enforced by `tools/governance` on every pull request.
- **Fresh-agent continuation:** [`AI_CONTINUATION.md`](AI_CONTINUATION.md) — current project state, exact milestone revisions, remaining verification gates, and the next Architect handoff.
- **Agent rules:** [`AGENTS.md`](AGENTS.md) and [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — role boundaries, implementation protocol, evidence discipline and stop gates.
- **Detailed Architect handoff:** [`docs/LLM-ARCHITECT-HANDOFF.md`](docs/LLM-ARCHITECT-HANDOFF.md).

## Current product direction

The CAD/BIM product is being completed to a defined first-phase **complete-enough** boundary before broader ConstructionOS platform work proceeds. The full-parity program ([`spec/cad-bim/roadmap.md`](spec/cad-bim/roadmap.md), product architecture v1.0 FROZEN under ConstructionOS v1.1) drives toward AutoCAD-class drafting and Archicad-class BIM workflow parity.

P018 (`CAD-PARITY-018`, Issue #118) has been merged into main at `3edd5506d972dc309b22c21baad7643f021f27d4`. **Merge is not the same as VERIFIED**: the next Architect must complete the post-merge governance verification described in `AI_CONTINUATION.md` and `docs/LLM-ARCHITECT-HANDOFF.md` before releasing a successor milestone.

Project/scheduling and Sheets/Office are independent implementation tracks and may proceed in parallel on separate branches. They integrate through the same Architecture v1.1 domain, application, event, persistence, and Construction Graph contracts.

## Quick start (governance tooling)

```bash
npm ci
npm test                                    # deterministic governance test suite
npm run governance -- validate              # validate all work-item records
npm run governance -- check-protected --base main
npm run governance -- check-verified-revisions
```

Node.js ≥ 20 is required.

## Web host deployments (Vercel)

- **Repository:** `pectoraux/offisos` — **web root:** `apps/web` (Next.js 16 host; the canonical `@offisos/cad-app-shell` contracts resolve from `../../app/src/*` through the `apps/web/tsconfig.json` path alias — never duplicated or forked).
- **Vercel project:** `offisos` (project id `prj_p4IGIM5pBpL8pgVdfJhczR789BFL`) in the **`ekonplacidegmailcoms-projects`** scope/team. **Scope warning:** the project is visible only from that team scope — a Vercel session connected under a different team or personal scope will not list it, and the dashboard will look like the project is missing. Switch the active scope in the Vercel dashboard before concluding the project does not exist. Production URL: <https://offisos.vercel.app>.
- **Project settings:** framework Next.js, **Root Directory `apps/web`** (never the repository root), Node 24. Vercel installs the `apps/web` dependencies and runs the repository's own build (`next build --webpack`, including the `extensionAlias` mapping for the canonical `.js`→`.ts` ESM specifiers); `typescript.ignoreBuildErrors` and the webpack fallback are deliberate configuration — do not casually remove them.
- **Git integration is NOT connected:** pushes to `main` do **not** auto-deploy, and merging a milestone never updates production. Every production deployment is made explicitly from a clean checkout of the exact `main` revision, binding the deployment to the deployed SHA for auditability:
  ```bash
  vercel deploy --prod --project offisos --scope ekonplacidegmailcoms-projects \
    --yes --meta gitsha="$(git rev-parse HEAD)" --token "$VERCEL_TOKEN"
  ```
  Tokens are used ephemerally from the environment and must never be committed; `.vercel/` and `.env*` are gitignored.
- **Production vs preview:** `--prod` reassigns the production alias `offisos.vercel.app` (plus the project's team-suffix domain) to the new deployment. Preview deployments stay on per-deployment URLs and never touch the production alias. Automatic PR previews would additionally require the Vercel GitHub App to be granted access to `pectoraux/offisos` (<https://github.com/apps/vercel/installations/new>); that grant is currently absent.
- **Serverless boundary:** the engine-free CAD/BIM demo (drafting, BIM authoring, components/materials, `/api/cad`) runs with no external secrets. The OCCT/IFC Python engine workers are unavailable on serverless; `ifc.*` operations return the typed `ifc_unavailable` decline there — a diagnostic-only boundary, consistent with the P019/P020 certification records.
