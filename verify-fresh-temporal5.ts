import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { loadDataset } from './eval/longmemeval/src/loader';
import { ingestQuestion } from './eval/longmemeval/src/ingest';
import { recallQuestion } from './eval/longmemeval/src/recall';
import { judgeAnswer } from './eval/longmemeval/src/judge';
import { waitForSessionReadiness } from './eval/longmemeval/src/readiness';

const root = process.cwd();
for (const envPath of [
  path.join(root, 'eval', 'longmemeval', '.env.local'),
  path.join(root, '.env.local'),
  path.join(root, '.env'),
]) {
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: false });
}

const questionIds = fs.readFileSync('eval/longmemeval/packs/temporal-gold-16.txt', 'utf8').trim().split('\n').slice(0,5);
const apiBase = process.env.ENGRAM_API_BASE || 'http://localhost:3002';
const apiKey = process.env.ENGRAM_API_KEY || process.env.X_AM_API_KEY || '';
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const readModel = process.env.LONGMEMEVAL_READ_MODEL || 'claude-opus-4-7';
if (!apiKey) throw new Error('Missing ENGRAM_API_KEY');
if (!anthropicApiKey) throw new Error('Missing ANTHROPIC_API_KEY');

(async () => {
  const questions = await loadDataset({ subset: 'full', category: 'temporal-reasoning-ability', questionIds });
  const runSuffix = `fresh-${Date.now()}`;
  let correct = 0;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const freshQ = { ...q, question_id: `${q.question_id}-${runSuffix}` };
    const started = Date.now();
    process.stdout.write(`[${i+1}/${questions.length}] ${q.question_id} ... `);
    try {
      const ingest = await ingestQuestion(freshQ, { apiBase, apiKey });
      await waitForSessionReadiness(ingest.userId, ingest.agentId, ingest.sessionId, ingest.chunks, { apiBase, apiKey }, 120000, 2000);
      const recall = await recallQuestion(q.question_id, q.question, ingest, { apiBase, apiKey, anthropicApiKey, readModel });
      const judge = await judgeAnswer(q.question, q.answer, recall.answer, anthropicApiKey);
      if (judge.correct) correct++;
      console.log(`${judge.correct ? 'PASS' : 'FAIL'} (${Date.now()-started}ms)`);
      console.log(JSON.stringify({ questionId: q.question_id, expected: q.answer, predicted: recall.answer, correct: judge.correct, judgeReasoning: judge.reasoning }));
    } catch (err) {
      console.log(`ERROR (${Date.now()-started}ms)`);
      console.log(JSON.stringify({ questionId: q.question_id, error: (err as Error).message }));
    }
  }
  console.log(`SUMMARY ${correct}/${questions.length}`);
})();
