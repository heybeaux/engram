# Engram

The memory faculty in the heybeaux stack. Stores agent memories across layers (IDENTITY, PROJECT, SESSION, TASK), embeds with a multi-model ensemble, recalls by natural-language query with importance ranking. Open source. Runs locally (default 3002) or in Railway cloud. Marketed under engram.ginnung.ai with openengram.ai as the live app/dashboard.

**Provides:** memory-faculty, persistent-memory, embedding-recall
**Repo:** https://github.com/heybeaux/engram (default branch: `staging`)
**Relates to:** Engram is one of Sonder's six faculties; emits/responds to SonderEvents; used by Inos for node persistence + dedup

**Current state:** main/staging diverged 2026-03+; 4 GIN-* hotfixes pending port onto staging (Prisma v6→v7). PRs go against staging until reconciled.
