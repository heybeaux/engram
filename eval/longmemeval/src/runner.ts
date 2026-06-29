#!/usr/bin/env ts-node
/**
 * LongMemEval eval harness — CLI entry point.
 *
 * Usage:
 *   pnpm longmemeval [--limit N] [--category CATEGORY] [--subset smoke|full]
 *                    [--resume PATH] [--results-dir DIR] [--output PATH]
 *                    [--batch-ingest] [--ingest-concurrency N]
 *                    [--skip-ingest] [--post-ingest-wait MS]
 *
 * Env vars:
 *   ENGRAM_API_BASE          — default: http://localhost:3000
 *   ENGRAM_API_KEY           — required
 *   ANTHROPIC_API_KEY        — required (for judge + reading model)
 *   LONGMEMEVAL_READ_MODEL   — default: claude-opus-4-7
 *   HUGGINGFACE_TOKEN        — required only for --subset=full
 *
 * Output:
 *   eval/longmemeval/results/<subset>-<ts>.jsonl  (streamed, one line per question)
 *   eval/longmemeval/summary.json                  (final aggregate)
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadDataset } from './loader';
import { ingestQuestion, batchIngest, waitForEmbeddingDrain } from './ingest';
import { recallQuestion } from './recall';
import { judgeAnswer } from './judge';
import { buildSummary, formatSummary, loadResultsFromJsonl } from './scorer';
import type { RunConfig, QuestionResult, LmeCategory } from './types';

const DEFAULT_OUTPUT_PATH = path.join(__dirname, '..', 'summary.json');
const DEFAULT_RESULTS_DIR = path.join(__dirname, '..', 'results');

interface ParsedArgs extends Partial<RunConfig> {
  outputPath: string;
  resultsDir: string;
  resumePath?: string;
  skipIngest?: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const opts: ParsedArgs = {
    outputPath: DEFAULT_OUTPUT_PATH,
    resultsDir: DEFAULT_RESULTS_DIR,
    subset: 'smoke',
    judgeModel: process.env.LONGMEMEVAL_JUDGE_MODEL ?? 'claude-opus-4-7',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit' && args[i + 1]) {
      opts.limit = parseInt(args[++i], 10);
    } else if (arg === '--category' && args[i + 1]) {
      opts.category = args[++i] as LmeCategory;
    } else if (arg === '--subset' && args[i + 1]) {
      const sub = args[++i];
      if (sub === 'smoke' || sub === 'full') {
        opts.subset = sub;
      } else {
        console.error(`Unknown --subset value: ${sub}. Use smoke or full.`);
        process.exit(1);
      }
    } else if (arg === '--output' && args[i + 1]) {
      opts.outputPath = args[++i];
    } else if (arg === '--resume' && args[i + 1]) {
      opts.resumePath = args[++i];
    } else if (arg === '--results-dir' && args[i + 1]) {
      opts.resultsDir = args[++i];
    } else if (arg === '--skip-ingest') {
      opts.skipIngest = true;
    } else if (arg === '--post-ingest-wait' && args[i + 1]) {
      opts.postIngestWaitMs = parseInt(args[++i], 10);
    } else if (arg === '--batch-ingest') {
      opts.batchIngest = true;
    } else if (arg === '--ingest-concurrency' && args[i + 1]) {
      opts.ingestConcurrency = parseInt(args[++i], 10);
    }
  }

  return opts;
}

/** Filesystem-safe ISO timestamp: 2026-05-22T19-03-12-345Z */
function fsTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

function resolveResultsPath(parsed: ParsedArgs): { resultsPath: string; resume: boolean } {
  if (parsed.resumePath) {
    const resolved = path.resolve(parsed.resumePath);
    if (!fs.existsSync(resolved)) {
      console.error(`Error: --resume path does not exist: ${resolved}`);
      process.exit(1);
    }
    return { resultsPath: resolved, resume: true };
  }
  if (!fs.existsSync(parsed.resultsDir)) {
    fs.mkdirSync(parsed.resultsDir, { recursive: true });
  }
  const filename = `${parsed.subset ?? 'smoke'}-${fsTimestamp()}.jsonl`;
  return { resultsPath: path.join(parsed.resultsDir, filename), resume: false };
}

function buildConfig(parsed: ParsedArgs): RunConfig {
  const apiBase = process.env.ENGRAM_API_BASE ?? 'http://localhost:3000';
  const apiKey = process.env.ENGRAM_API_KEY ?? process.env.X_AM_API_KEY ?? '';
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const readModel = process.env.LONGMEMEVAL_READ_MODEL ?? 'claude-opus-4-7';

  if (!apiKey) {
    console.error('Error: ENGRAM_API_KEY env var is required');
    process.exit(1);
  }
  if (!anthropicApiKey) {
    console.error('Error: ANTHROPIC_API_KEY env var is required');
    process.exit(1);
  }

  const { resultsPath, resume } = resolveResultsPath(parsed);

  return {
    apiBase,
    apiKey,
    anthropicApiKey,
    readModel,
    judgeModel: process.env.LONGMEMEVAL_JUDGE_MODEL ?? 'claude-opus-4-7',
    limit: parsed.limit,
    category: parsed.category,
    subset: parsed.subset ?? 'smoke',
    outputPath: parsed.outputPath,
    resultsPath,
    resume,
    skipIngest: parsed.skipIngest,
    postIngestWaitMs: parsed.postIngestWaitMs ?? 8000,
    batchIngest: parsed.batchIngest,
    ingestConcurrency: parsed.ingestConcurrency,
  };
}

/** Append one QuestionResult as a JSON line. Sync write — durability > throughput. */
function appendResult(jsonlPath: string, result: QuestionResult): void {
  fs.appendFileSync(jsonlPath, JSON.stringify(result) + '\n', 'utf-8');
}

async function main() {
  const parsed = parseArgs();
  const config = buildConfig(parsed);

  // Print the JSONL path on the FIRST line of stdout so the user can copy it
  // for a future --resume even if everything else scrolls away.
  console.log(`Results JSONL: ${config.resultsPath}`);
  console.log('');
  console.log(`LongMemEval Eval Harness`);
  console.log(`  subset:   ${config.subset}`);
  console.log(`  limit:    ${config.limit ?? 'none'}`);
  console.log(`  category: ${config.category ?? 'all'}`);
  console.log(`  readModel: ${config.readModel}`);
  console.log(`  apiBase:   ${config.apiBase}`);
  console.log(`  resume:    ${config.resume ? 'yes' : 'no'}`);
  console.log(`  skipIngest: ${config.skipIngest ? 'yes (reusing existing sessions)' : 'no'}`);
  console.log(`  batchIngest: ${config.batchIngest ? `yes (concurrency ${config.ingestConcurrency ?? 4})` : 'no'}`);
  console.log('');

  // Load dataset
  console.log('Loading dataset...');
  const questions = await loadDataset(config);
  console.log(`  ${questions.length} questions loaded`);

  if (questions.length === 0) {
    console.error('No questions to evaluate after filtering. Exiting.');
    process.exit(1);
  }

  // Load already-completed results when resuming
  const priorResults = config.resume ? loadResultsFromJsonl(config.resultsPath) : [];
  const completedIds = new Set(priorResults.map(r => r.questionId));

  if (config.resume) {
    const remaining = questions.filter(q => !completedIds.has(q.question_id));
    console.log(
      `Resuming from ${config.resultsPath}: ${completedIds.size} questions already complete, ${remaining.length} remaining`,
    );
    console.log('');
  }

  // Batch-ingest phase: push all haystacks up front, then run the query loop
  // with no per-question embedding wait. Ingest progress is recorded in a
  // manifest JSONL next to the results file, so a crashed run resumes without
  // double-ingesting (which would duplicate memories).
  if (config.batchIngest && !config.skipIngest) {
    const toIngest = questions.filter(q => !completedIds.has(q.question_id));
    if (toIngest.length > 0) {
      const manifestPath = config.resultsPath.replace(/\.jsonl$/, '') + '.ingest.jsonl';
      console.log(`Batch ingest: ${toIngest.length} questions (manifest: ${manifestPath})`);
      const { ingested, skipped } = await batchIngest(
        toIngest,
        config,
        manifestPath,
        config.ingestConcurrency ?? 4,
        (done, total) => {
          if (done % 10 === 0 || done === total) {
            console.log(`  ingested ${done}/${total}`);
          }
        },
      );
      console.log(`Batch ingest complete: ${ingested} ingested, ${skipped} already in manifest`);

      // Queue is FIFO — once the last-ingested sessions are searchable, all are.
      const probes = toIngest.slice(-3).map(q => ({ questionId: q.question_id, query: q.question }));
      process.stdout.write('Waiting for embedding queue to drain...');
      const drained = await waitForEmbeddingDrain(probes, config);
      console.log(drained ? ' drained.' : ' TIMEOUT after 180s — proceeding anyway (recall may be thin for tail questions).');
      console.log('');
    }
  }
  // After batch ingest, the loop must not re-ingest or wait per question.
  const reuseExistingSessions = config.skipIngest || config.batchIngest;

  // Graceful shutdown — let in-flight question finish, then exit
  let shouldStop = false;
  let stopSignal = '';
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shouldStop) {
      // Second Ctrl-C: force exit
      console.log(`\nReceived second ${signal}, forcing exit immediately.`);
      process.exit(130);
    }
    shouldStop = true;
    stopSignal = signal;
    console.log(`\nReceived ${signal}, finishing in-flight question then exiting...`);
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  // Run evaluation, streaming results to JSONL
  let done = priorResults.length;
  const totalToRun = questions.length;
  // Infra errors (API outage, credit limit) must NOT be recorded as wrong
  // answers — skip the append so --resume retries them. Abort on a streak,
  // which almost always means a systemic outage rather than a flaky question.
  const MAX_CONSECUTIVE_ERRORS = 3;
  let consecutiveErrors = 0;

  for (const question of questions) {
    if (completedIds.has(question.question_id)) {
      continue;
    }
    if (shouldStop) {
      break;
    }

    const start = Date.now();
    process.stdout.write(`  [${done + 1}/${totalToRun}] ${question.question_id} ...`);

    let result: QuestionResult;
    try {
      // Sessions already in DB (--skip-ingest or batch-ingest phase):
      // reconstruct IngestResult from deterministic IDs (no API call)
      const ingestResult = reuseExistingSessions
        ? {
            questionId: question.question_id,
            sessionId: `lme-${question.question_id}`,
            userId: `lme-${question.question_id}`,
            agentId: `lme-${question.question_id}`,
            memoryIds: [],
            chunks: 0,
          }
        : await ingestQuestion(question, config);
      // The embedding queue is async — vectors land 1-3s after bulk ingest
      // returns. Recalling immediately races it and recall comes back empty.
      if (!reuseExistingSessions && (config.postIngestWaitMs ?? 0) > 0) {
        await new Promise(r => setTimeout(r, config.postIngestWaitMs));
      }
      const recallResult = await recallQuestion(
        question.question_id,
        question.question,
        ingestResult,
        config,
        question.category,
        question.question_date,
      );
      const judgeResult = await judgeAnswer(
        question.question,
        question.answer,
        recallResult.answer,
        config.anthropicApiKey,
      );
      const latencyMs = Date.now() - start;
      result = {
        questionId: question.question_id,
        question: question.question,
        expected: question.answer,
        predicted: recallResult.answer,
        correct: judgeResult.correct,
        category: question.category,
        latencyMs,
        judgeReasoning: judgeResult.reasoning,
        timestamp: new Date().toISOString(),
      };
      const mark = judgeResult.correct ? '✓' : '✗';
      console.log(` ${mark} (${latencyMs}ms)`);
      consecutiveErrors = 0;
    } catch (err) {
      console.log(` ERROR: ${(err as Error).message}`);
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('');
        console.error(
          `Aborting after ${consecutiveErrors} consecutive errors — likely an API/credit outage, not flaky questions.`,
        );
        console.error(`Completed so far: ${done}/${totalToRun}. Errored questions were NOT recorded and will be retried.`);
        console.error(`Resume with: pnpm longmemeval --subset ${config.subset} --resume ${config.resultsPath}`);
        process.exit(1);
      }
      continue;
    }

    // Durable append BEFORE bumping counters or considering stop
    appendResult(config.resultsPath, result);
    completedIds.add(question.question_id);
    done++;
  }

  if (shouldStop) {
    console.log('');
    console.log(`Stopped after ${stopSignal}. Completed: ${done}/${totalToRun}.`);
    console.log(`Resume with: pnpm longmemeval --subset ${config.subset} --resume ${config.resultsPath}`);
    process.exit(130);
  }

  // Build final summary from the on-disk JSONL — single source of truth
  const allResults = loadResultsFromJsonl(config.resultsPath);
  const summary = buildSummary(allResults, config.subset);

  const outputDir = path.dirname(config.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(config.outputPath, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(formatSummary(summary));
  console.log(`Summary written to: ${config.outputPath}`);
  console.log(`Results JSONL:      ${config.resultsPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
