#!/usr/bin/env ts-node
/**
 * Verification harness for HEY-579 (S5 resume/checkpoint).
 *
 * Drives the same JSONL streaming + signal-handler + resume flow used by
 * runner.ts, but with a fake per-question processor so we can verify behavior
 * without ENGRAM_API_KEY / ANTHROPIC_API_KEY.
 *
 * Usage:
 *   ts-node verify-resume.ts --limit 5 [--resume PATH] [--results-dir DIR]
 *                            [--crash-after N]
 *
 * Implementation mirrors runner.ts's loop; if you change one, change both.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildSummary, loadResultsFromJsonl } from '../src/scorer';
import type { QuestionResult } from '../src/types';

interface Args {
  limit: number;
  resumePath?: string;
  resultsDir: string;
  crashAfter?: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    limit: 5,
    resultsDir: path.join(__dirname, '..', 'results-verify'),
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') out.limit = parseInt(args[++i], 10);
    else if (a === '--resume') out.resumePath = args[++i];
    else if (a === '--results-dir') out.resultsDir = args[++i];
    else if (a === '--crash-after') out.crashAfter = parseInt(args[++i], 10);
  }
  return out;
}

function fsTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

function appendResult(jsonlPath: string, r: QuestionResult): void {
  fs.appendFileSync(jsonlPath, JSON.stringify(r) + '\n', 'utf-8');
}

async function fakeProcess(qid: string): Promise<QuestionResult> {
  // Simulate ~200ms of work, like a real ingest+recall+judge cycle (but much faster)
  await new Promise(res => setTimeout(res, 200));
  return {
    questionId: qid,
    question: `fake question ${qid}`,
    expected: 'gold',
    predicted: 'gold',
    correct: true,
    category: 'single-session-user',
    latencyMs: 200,
    judgeReasoning: 'fake',
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs();

  let resultsPath: string;
  let resume = false;
  if (args.resumePath) {
    resultsPath = path.resolve(args.resumePath);
    if (!fs.existsSync(resultsPath)) {
      console.error(`--resume path missing: ${resultsPath}`);
      process.exit(1);
    }
    resume = true;
  } else {
    if (!fs.existsSync(args.resultsDir)) fs.mkdirSync(args.resultsDir, { recursive: true });
    resultsPath = path.join(args.resultsDir, `verify-${fsTimestamp()}.jsonl`);
  }

  console.log(`Results JSONL: ${resultsPath}`);
  console.log(`  limit:  ${args.limit}`);
  console.log(`  resume: ${resume}`);
  if (args.crashAfter) console.log(`  crashAfter (SIGINT to self): ${args.crashAfter}`);
  console.log('');

  const prior = resume ? loadResultsFromJsonl(resultsPath) : [];
  const completed = new Set(prior.map(r => r.questionId));

  if (resume) {
    const remaining = args.limit - completed.size;
    console.log(`Resuming from ${resultsPath}: ${completed.size} complete, ${remaining} remaining`);
    console.log('');
  }

  let shouldStop = false;
  let stopSignal = '';
  const handle = (sig: NodeJS.Signals) => {
    if (shouldStop) {
      console.log(`\nReceived second ${sig}, forcing exit.`);
      process.exit(130);
    }
    shouldStop = true;
    stopSignal = sig;
    console.log(`\nReceived ${sig}, finishing in-flight question then exiting...`);
  };
  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);

  let done = completed.size;
  for (let i = 1; i <= args.limit; i++) {
    const qid = `verify-q${i}`;
    if (completed.has(qid)) continue;
    if (shouldStop) break;

    process.stdout.write(`  [${done + 1}/${args.limit}] ${qid} ...`);
    const r = await fakeProcess(qid);
    appendResult(resultsPath, r);
    completed.add(qid);
    done++;
    console.log(` ✓`);

    if (args.crashAfter && done === args.crashAfter) {
      // Self-SIGINT to simulate Ctrl-C; current question already written
      process.kill(process.pid, 'SIGINT');
      // Give the handler a tick to fire, then continue loop so the next iter sees shouldStop
      await new Promise(res => setImmediate(res));
    }
  }

  if (shouldStop) {
    console.log('');
    console.log(`Stopped after ${stopSignal}. Completed: ${done}/${args.limit}.`);
    console.log(`Resume with: --resume ${resultsPath}`);
    process.exit(130);
  }

  const allResults = loadResultsFromJsonl(resultsPath);
  const summary = buildSummary(allResults, 'smoke');
  console.log('');
  console.log(`Final: ${summary.correctCount}/${summary.totalQuestions} correct`);
  console.log(`Results JSONL: ${resultsPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
