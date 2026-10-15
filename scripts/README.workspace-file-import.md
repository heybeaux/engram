# OpenClaw workspace-file import

The authenticated `POST /v1/memories/bulk/workspace-file` endpoint is disabled
unless `ENABLE_WORKSPACE_FILE_IMPORT=true` on the API process. Each request
requires a relative Markdown path, the complete text, the source file date,
the source file's UTC modification time, and an inclusive `YYYY-MM-DD` cutoff.
It creates paragraph chunks with heading
context and metadata for the path, SHA-256 of the entire file, and 1-based
source line range (and heading line when used). An unchanged file is skipped on repeat import. A later
cutoff can add previously skipped dated sections of the same file.
Each imported row also retains the source modification time and the unmodified
chunk-text SHA-256 for independent as-of and content-integrity checks.

The local-file CLI enumerates OpenClaw workspace `memory/*.md`, `MEMORY.md`,
`DELEGATION.md`, and `exports/*.md` under the root workspace or an
`agents/*/workspace` directory (without following directory symlinks).
Daily file names supply the date; otherwise the CLI uses the file's UTC mtime.
The importer rejects files dated after the cutoff and sections with a later
dated heading or date-prefixed paragraph. It also rejects a source file whose
modification time is after the cutoff, even if its filename has an older date.
The CLI submits these files to the private API to get exact `afterCutoff`
chunk counts; it produces one JSON line of `created`, `skipped`, and
`afterCutoff` counts per relative file path and a final totals line. It stops
if a file changes while being read. A failed run has no final totals line.
**It cannot reconstruct older versions of a file from its
current text.** For an as-of evaluation, use an as-of source snapshot or
verify that each file's contents existed at the cutoff. An undated file edited
after the cutoff is intentionally excluded.

Run only against a separate local `engram_dev*` or `engram_eval*` throwaway DB
and its private API. Never point this tool at the live local API on port 47291,
the live `engram` database, or production. The CLI checks the local DB URL and
API endpoint before it reads files. Set `ENGRAM_IMPORT_API_KEY` in the shell
without printing it. For example, with a **private eval API** already running
on port 3072 using the same throwaway `DATABASE_URL`:

```sh
ENABLE_WORKSPACE_FILE_IMPORT=true pnpm exec ts-node --transpile-only scripts/import-openclaw-workspace.ts \
  --root=/path/to/openclaw --cutoff=2026-07-25 \
  --api-url=http://127.0.0.1:3072 --user-id=beaux
```

The API and CLI must both have the flag enabled. Embeddings use the normal
bulk-write queue; wait for them to finish before measuring retrieval. The CLI
cannot prove that the API process uses the same database as the shell. Verify
its environment independently before starting it. The CLI does not send
workspace files to third-party services, but the normal embedding provider of
the private API may receive imported chunks: configure a local provider when
handling private workspace data.
