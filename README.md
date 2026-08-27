# Offisos — Construction Operating System

> One shared construction reality model, exposed through familiar professional tools and intelligent workflows.

- **Architecture:** v1.1, FROZEN — see [`spec/architecture.md`](spec/architecture.md) and [`spec/architecture-lock.md`](spec/architecture-lock.md).
- **Current implementation roadmap:** [`spec/roadmap-v1.1.md`](spec/roadmap-v1.1.md).
- **Historical v1.0 backlog:** [`spec/work-items.md`](spec/work-items.md) — retained for historical traceability while the current v1.1 roadmap is maintained separately.
- **Specification package:** [`spec/00-readme.md`](spec/00-readme.md) — architecture, requirements, work items, dependency graph, research plan.
- **Development governance:** [`governance/README.md`](governance/README.md) — the executable work-item lifecycle (state machine, evidence policy, Architect review), enforced by `tools/governance` on every pull request.

## Current product direction

The CAD/BIM product is being completed to a defined first-phase **complete-enough** boundary before broader ConstructionOS platform work proceeds. A later, separate program may pursue deeper AutoCAD and Archicad-class feature parity without blocking Project, Office, platform, Graph, collaboration, AI, or intelligence development.

Project/scheduling and Sheets/Office are independent implementation tracks and may proceed in parallel on separate branches. They integrate through the same Architecture v1.1 domain, application, event, persistence, and Construction Graph contracts.

## Quick start (governance tooling)

```bash
npm ci
npm test                                    # deterministic governance test suite
npm run governance -- validate              # validate all work-item records
npm run governance -- check-protected --base main
```

Node.js ≥ 20 is required.

## Web host preview deployments (Vercel)

- **Repository:** `pectoraux/offisos` — **web root:** `apps/web` (Next.js 16 host; the canonical `@offisos/cad-app-shell` contracts resolve from `../../app/src/*` through the `apps/web/tsconfig.json` path alias — never duplicated or forked).
- **Vercel project:** `offisos` — framework Next.js, **Root Directory `apps/web`**, "Include files outside the Root Directory" enabled (required for the monorepo `app/src` imports). Vercel detects `apps/web/bun.lock` and installs with Bun, then runs the repo's own build (`next build --webpack`, including the `extensionAlias` mapping for the canonical `.js`→`.ts` ESM specifiers).
- **Preview vs production:** preview deployments are per-deployment URLs (one per deployment of a branch/PR) and never touch the production alias; production deployments happen only from the production branch (`main`) via the Git integration or an explicit `--prod` deploy. The engine-free CAD/BIM demo (drafting, BIM authoring, components/materials, `/api/cad`) runs with no external secrets; the OCCT/IFC Python engine workers are unavailable on serverless and the app stays on engine-free paths there.
- **Deploying a preview from a local checkout** (same source of truth, no repo changes): `vercel link --project offisos` at the repository root, then `vercel deploy --token "$VERCEL_TOKEN"` (the token is used ephemerally and must never be committed; `.vercel/` and `.env*` are gitignored).
- **Git integration for automatic PR previews** requires the Vercel GitHub App to be granted access to `pectoraux/offisos` (GitHub → Settings → Applications → Vercel, or <https://github.com/apps/vercel/installations/new>); once granted, every PR/branch automatically produces a Preview Deployment for `apps/web`.
