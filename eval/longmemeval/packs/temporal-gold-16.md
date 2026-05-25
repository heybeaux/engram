# Temporal Gold Pack 16

**Created:** May 24, 2026  
**Purpose:** Stable, small temporal dev loop for Engram LongMemEval work.

This pack is intentionally not a random sample. It is a curated set of 16
temporal questions chosen from the May 23, 2026 full-500 baseline and the
May 24, 2026 temporal rerun.

## Selection Rule

- 12 questions are **stayed wrong** across both the baseline and the
  `--reuse-existing` temporal rerun.
- 4 questions are **regression probes** that were correct in the baseline but
  flipped wrong in the temporal rerun.

That keeps the pack useful for both:
- product work on real temporal failures
- eval work on rerun stability and nondeterminism

## Command

```bash
ENGRAM_API_KEY=<your-key> \
ANTHROPIC_API_KEY=<your-key> \
HUGGINGFACE_TOKEN=<your-token> \
pnpm longmemeval \
  --subset full \
  --category temporal-reasoning-ability \
  --question-ids-file eval/longmemeval/packs/temporal-gold-16.txt
```

For fast post-fix comparisons against already-ingested LongMemEval sessions:

```bash
ENGRAM_API_KEY=<your-key> \
ANTHROPIC_API_KEY=<your-key> \
HUGGINGFACE_TOKEN=<your-token> \
pnpm longmemeval \
  --subset full \
  --category temporal-reasoning-ability \
  --question-ids-file eval/longmemeval/packs/temporal-gold-16.txt \
  --reuse-existing
```

## Question Groups

### 1. Event ordering across multiple memories

- `gpt4_f49edff3` — nursery / baby shower / phone case ordering
- `gpt4_4929293a` — cousin's wedding vs Michael's engagement party
- `gpt4_7abb270c` — six museums from earliest to latest
- `gpt4_68e94287` — `#PlankChallenge` vs vegan chili post

### 2. Date-difference arithmetic from resolved event times

- `gpt4_59149c77` — MoMA vs Met exhibit
- `gpt4_fa19884c` — old keyboard vs bluegrass band
- `gpt4_1916e0ea` — FarmFresh cancellation vs Instacart
- `gpt4_7a0daae1` — tennis racket order vs delivery
- `gpt4_1d4ab0c9` — herb garden start vs first harvest
- `9a707b81` — baking class vs birthday cake
- `gpt4_1d80365e` — Yosemite solo camping trip duration
- `gpt4_76048e76` — bike vs car first in February

### 3. Relative-time retrieval anchored to a resolved date

- `9a707b82` — what was cooked "a couple of days ago"
- `eac54add` — business milestone from four weeks ago
- `0bc8ad93` — museum visit two months ago, with a friend or not
- `gpt4_b5700ca0` — where the religious activity happened last week

## Interpretation Rules

- If the stayed-wrong set starts flipping correct, product work is paying off.
- If the regression probes keep bouncing, the eval loop is still noisy.
- Do not treat this pack as a replacement for the full temporal category.
- Use it as the fast gate before running the full 133 temporal questions.
