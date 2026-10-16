# ENG-122 isolated PostgreSQL supersession check

Date: 2026-10-15. Script: `check-supersession-db.cjs`, SHA-256
`3e94abc92a928096262431940ae5447d34cf6e5db176a129a6ca8d2ad41102cc`.

This check used a new PostgreSQL 14 cluster under Paperclip's run-owned scratch
directory, bound to a dynamically assigned loopback port. It created a separate
`eng122test` database with the `vector` extension and populated the current
Prisma schema with `pnpm exec prisma db push --url <throwaway URL>`. The script
requires the database name `eng122test`, a non-5432 loopback port, and the
explicit `ENG122_THROWAWAY_DB=1` environment flag. It does not load the live
API's environment file. The server was stopped after the check; Paperclip
removes the scratch directory at run end. The local Engram database and
production were not accessed.

| Step                                                  | Observed result                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flag unset, `SUPERSEDES` candidate at 0.95 confidence | Candidate queued; old row had no supersession link; zero merge events                                                                                                    |
| Flag on, same candidate                               | One automatic supersession; older and newer raw content intact; older `deletedAt` null and `supersededById` pointed to newer row; one rollback-capable `SUPERSEDE` event |
| Rollback                                              | Older link and timestamp cleared; content and active status preserved; event marked rolled back; second rollback rejected                                                |

The first container attempt failed before startup because Docker's VM reported
`No space left on device`; it was removed and no test ran there. The first
isolated-host script attempt reached rollback successfully, then failed an
assertion on the error wording for a second rollback (`cannot be rolled back`
versus the expected `already been rolled back`). The assertion was corrected.
The throwaway database was recreated and the full script passed.

`pnpm exec prisma db push --url <throwaway URL>` exited 0. The final
`node eval/jev-decisions/check-supersession-db.cjs` exited 0. Prettier on the
new script, ESLint on all three ENG-122 eval scripts, TypeScript, and
`git diff --check` exited 0. Four focused Jest suites passed 53/53.

This proves row effects for the synthetic pair in an isolated database. It does
not establish classifier safety on unseen pairs. Eval's first held-out v3
measurement failed the harm gate at 3/60 false supersessions, so the flag stays
off and there is no end-to-end knowledge-update lift claim.
