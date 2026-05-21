# Engram Benchmarks

Benchmarks for validating Engram recall quality on specific use cases.

## Campaign Recall Benchmark

Tests semantic recall precision for structured marketing campaign data.

**Results (2026-03-23):**
- Format A (raw prose): Grade D, Mean P@5 21.3%, Client Isolation 19.5%
- Format B (pre-computed insights): Grade D, Mean P@5 17.0%, Client Isolation 20.3%

**Root causes:** No metadata filtering, usage-bias crowding, no client isolation.
**Recommendation:** Pool-based isolation + metadata pre-filter required before shipping.

See [channel-intelligence-spec](https://github.com/heybeaux/ops/blob/main/specs/channel-intelligence-spec.md) for the fix plan.
