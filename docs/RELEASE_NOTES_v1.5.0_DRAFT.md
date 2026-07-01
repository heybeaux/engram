# Engram v1.5.0 release notes draft

> Release status: published. GitHub Release `v1.5.0` exists, and `@openengram/engram@1.5.0` is published on npm. Keep this file as the detailed release-note/provenance packet; do not move or recreate the existing tag to match later documentation/package metadata commits.

Engram v1.5.0 turns the first public release into a stronger self-hosted and cloud-ready memory platform. The headline work is the local/cloud edition split, first-run registration, cloud backup plumbing, instance-level keys, row-level security hardening, and a larger reliability/test pass around dashboard and memory APIs.

## Highlights

- **Self-hosted first-run setup** — adds setup-status and registration flows so new local installs can bootstrap through supported API/dashboard paths instead of manual database edits.
- **Local/cloud edition split** — introduces edition-aware configuration and CI so local-only deployments can stay simple while cloud/hybrid surfaces keep their own guardrails.
- **Cloud backup and migration foundations** — adds import/export APIs, cloud-link services, push-only cloud sync, content hashing, and instance sync keys for hybrid self-hosted ↔ cloud workflows.
- **Production auth and tenancy hardening** — adds multi-tenant accounts, usage limits, stricter auth guards, local-only LAN trust behavior, instance-level API keys, and RLS enablement across core tables.
- **Dashboard/API reliability** — fixes dashboard stats, JWT user resolution, default-agent resolution for instance keys, sync/admin transaction timeouts, CORS for local dashboard ports, and Railway build generation.
- **Memory and search improvements** — adds cloud ensemble embedding support, 5W extraction improvements, storage/embedding abstractions, git intelligence ingestion, and event/webhook infrastructure.
- **CI and test coverage** — splits local/cloud workflows, adds GitHub Actions hardening, and expands tests across auth guards, dashboard, account/admin/plan-limits, feedback, memory pipeline, Dream Cycle, and generate-context paths.

## Upgrade notes

- Use `pnpm run migrate:deploy` or `pnpm run migrate:safe` for existing/shared databases. Do **not** run `prisma migrate dev` or `prisma migrate reset` against real data.
- Review `EDITION`, local trust, CORS, cloud sync, and instance-key environment variables before promoting a deployment.
- Run the local and cloud CI workflows before cutting the release artifact.
- Verify self-hosted quickstart, first-run registration, `/v1/health`, and dashboard setup wizard against a clean database.

## Published release checklist

- [x] Confirmed `staging` was promoted to protected `production` through PR #307.
- [x] Confirmed required CI/checks were green before promotion and package metadata merge.
- [x] Confirmed existing release tag target SHA: `be41d6e37e12f2b8f6784cf4ebfd2c53622e4ac2`.
- [x] Confirmed package publishing scope: root package is now `@openengram/engram`, `private: false`, with `publishConfig.access: public`.
- [x] GitHub Release created: https://github.com/heybeaux/engram/releases/tag/v1.5.0
- [x] npm package published: https://www.npmjs.com/package/@openengram/engram/v/1.5.0

## Provenance and post-tag hardening

- Existing `v1.5.0` git tag target: `be41d6e37e12f2b8f6784cf4ebfd2c53622e4ac2` (`release: v1.5.0 — cloud sync, RLS, instance keys, auth guards, dashboard fixes`).
- Protected production promotion PR: https://github.com/heybeaux/engram/pull/307
- npm package metadata hardening PR: https://github.com/heybeaux/engram/pull/308
- Production head after PR #308: `ffa1dc8af7eea6f06e0f30a3dec5dba4a180939c`.
- npm artifact: `@openengram/engram@1.5.0`, tarball `https://registry.npmjs.org/@openengram/engram/-/engram-1.5.0.tgz`, integrity `sha512-oWOv4VqN21RZjMj9A3Iy/hrd3WgnhUTBiwh3pK3DEebKKa9DVDfY1BCaLxIrXo3ULZMUQKMl9LdtwC8PAS50xQ==`.
- Do not force-move or recreate the existing tag; preserve it and document the post-tag docs/package hardening explicitly.

## Evidence used for this packet

- `git log --first-parent v1.0.0..v1.5.0`
- `gh release view v1.5.0 --repo heybeaux/engram`
- `gh pr view 307 --repo heybeaux/engram`
- `gh pr view 308 --repo heybeaux/engram`
- `npm view @openengram/engram@1.5.0`
- Current `CHANGELOG.md` and root `package.json`
