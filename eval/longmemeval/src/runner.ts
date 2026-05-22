#!/usr/bin/env ts-node
/**
 * LongMemEval eval harness — CLI entry point.
 *
 * Usage:
 *   pnpm longmemeval [--limit N] [--category CATEGORY] [--subset smoke|full]
 *
 * Env vars:
 *   ENGRAM_API_BASE          — default: http://localhost:3000
 *   ENGRAM_API_KEY           — required
 *   ANTHROPIC_API_KEY        — required (for judge + reading model)
 *   LONGMEMEVAL_READ_MODEL   — default: claude-opus-4-7
 *   HUGGINGFACE_TOKEN        — required only for --subset=full
 *
 * Output: eval/longmemeval/summary.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadDataset } from './loader';
import { ingestQuestion } from './ingest';
import { recallQuestion } from './recall';
import { judgeAnswer } from './judge';
import { buildSummary, formatSummary } from './scorer';
import type { RunConfig, QuestionResult, LmeCategory } from './types';

const OUTPUT_PATH = path.join(__dirname, '..', 'summary.json');

function parseArgs(): Partial<RunConfig> & { outputPath: string } {
  const args = process.argv.slice(2);
  const opts: Partial<RunConfig> & { outputPath: string } = {
    outputPath: OUTPUT_PATH,
    subset: 'smoke',
    judgeModel: 'claude-opus-4-7',
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
    }
  }

  return opts;
}

function buildConfig(parsed: ReturnType<typeof parseArgs>): RunConfig {
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

  return {
    apiBase,
    apiKey,
    anthropicApiKey,
    readModel,
    judgeModel: 'claude-opus-4-7',
    limit: parsed.limit,
    category: parsed.category,
    subset: parsed.subset ?? 'smoke',
    outputPath: parsed.outputPath,
  };
}

async function main() {
  const parsed = parseArgs();
  const config = buildConfig(parsed);

  console.log(`LongMemEval Eval Harness`);
  console.log(`  subset:   ${config.subset}`);
  console.log(`  limit:    ${config.limit ?? 'none'}`);
  console.log(`  category: ${config.category ?? 'all'}`);
  console.log(`  readModel: ${config.readModel}`);
  console.log(`  apiBase:   ${config.apiBase}`);
  console.log('');

  // Load dataset
  console.log('Loading dataset...');
  const questions = await loadDataset(config);
  console.log(`  ${questions.length} questions loaded`);

  if (questions.length === 0) {
    console.error('No questions to evaluate after filtering. Exiting.');
    process.exit(1);
  }

  // Run evaluation
  const results: QuestionResult[] = [];
  let done = 0;

  for (const question of questions) {
    const start = Date.now();
    process.stdout.write(`  [${done + 1}/${questions.length}] ${question.question_id} ...`);

    try {
      // Step 1: Ingest session history
      const ingestResult = await ingestQuestion(question, config);

      // Step 2: Recall + CoN reading
      const recallResult = await recallQuestion(
        question.question_id,
        question.question,
        ingestResult,
        config,
      );

      // Step 3: Judge
      const judgeResult = await judgeAnswer(
        question.question,
        question.answer,
        recallResult.answer,
        config.anthropicApiKey,
      );

      const latencyMs = Date.now() - start;
      const result: QuestionResult = {
        questionId: question.question_id,
        question: question.question,
        expected: question.answer,
        predicted: recallResult.answer,
        correct: judgeResult.correct,
        category: question.category,
        latencyMs,
        judgeReasoning: judgeResult.reasoning,
      };
      results.push(result);

      const mark = judgeResult.correct ? '✓' : '✗';
      console.log(` ${mark} (${latencyMs}ms)`);
    } catch (err) {
      const latencyMs = Date.now() - start;
      console.log(` ERROR: ${(err as Error).message}`);
      results.push({
        questionId: question.question_id,
        question: question.question,
        expected: question.answer,
        predicted: '',
        correct: false,
        category: question.category,
        latencyMs,
        judgeReasoning: `Error: ${(err as Error).message}`,
      });
    }

    done++;
  }

  // Build summary
  const summary = buildSummary(results, config.subset);

  // Write output
  const outputDir = path.dirname(config.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(config.outputPath, JSON.stringify(summary, null, 2), 'utf-8');

  // Print report
  console.log(formatSummary(summary));
  console.log(`Summary written to: ${config.outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
