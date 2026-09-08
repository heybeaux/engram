const fs = require('node:fs');
const [input] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const result = {
  corpusSha256: report.corpusSha256,
  config: report.config,
  ingestion: report.ingestion.reduce((acc, row) => {
    const key = row.embeddingStatus || 'TIMEOUT'; acc[key] = (acc[key] || 0) + 1; return acc;
  }, {}),
  stages: {}, dream: report.dream, archival: report.archival,
  omissionControl: report.omissionControl,
  appCloseReturned: report.appCloseReturned,
  activeResourcesAfterClose: report.activeResourcesAfterClose,
  limitations: ['Lexical anchors are diagnostics, not semantic entailment.', 'No-answer retrieval abstention is not generated-answer correctness.', 'Explicit unknown evidence may be useful even when retrieval does not abstain.', 'Consolidation/archival stages are not full dream orchestration.'],
};
for (const [stage, value] of Object.entries(report.stages)) {
  const succeeded = value.queries.filter(q => q.status >= 200 && q.status < 300);
  const positive = succeeded.filter(q => !q.noAnswer);
  const negative = succeeded.filter(q => q.noAnswer);
  result.stages[stage] = {
    querySuccesses: succeeded.length, queryTotal: value.queries.length,
    positiveWithAllLexicalAnchors: positive.filter(q => q.expectedFacts.length && q.matchedFacts.length === q.expectedFacts.length).length,
    positiveCount: positive.length,
    sourceHitCount: positive.filter(q => q.results.some(r => r.relevant)).length,
    noAnswerAbstentions: negative.filter(q => q.results.length === 0).length,
    noAnswerCount: negative.length,
    missingAnchors: positive.map(q => ({id:q.id,missing:q.expectedFacts.filter(f => !q.matchedFacts.includes(f))})).filter(q => q.missing.length),
    searchableCount: value.rows.filter(r => r.searchable).length,
  };
}
console.log(JSON.stringify(result, null, 2));
