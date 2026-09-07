import { scoreQuery, buildReport, checkThresholds } from './scoring';
import type { GoldQuery } from '../fixtures/types';
const query: GoldQuery = {
  id: 'q',
  query: 'fact',
  user: 'a',
  must_top5: ['gold'],
  must_absent: ['forbidden'],
  category: 'semantic',
};
describe('honest benchmark accounting', () => {
  it('names a required hit plus four unjudged results coverage, never precision', () => {
    const score = scoreQuery(query, [
      'gold',
      'noise1',
      'noise2',
      'noise3',
      'noise4',
    ]);
    expect(score.requiredCoverageAt5).toBe(1);
    expect(score).not.toHaveProperty('precisionAt5');
  });
  it('excludes unlabelled queries and reports each label denominator', () => {
    const report = buildReport(
      [scoreQuery(query, []), scoreQuery({ ...query, must_top5: [] }, [])],
      'sha',
      'branch',
    );
    expect(report.overallRequiredCoverageAt5).toBe(0);
    expect(report.labelledTop5Count).toBe(1);
    expect(report.unlabelledCount).toBe(1);
    expect(report.overallExpectedCoverageAt20).toBeNull();
    expect(report.overallMrr).toBe(0);
  });
  it('separates explicit negative judgments from absent labels', () => {
    const negative = scoreQuery(
      { ...query, must_top5: [], expect_no_answer: true },
      ['noise'],
    );
    expect(negative.noAnswerPassed).toBe(false);
    expect(negative.passed).toBe(false);
    expect(checkThresholds([scoreQuery(query, ['gold']), negative])).toBe(
      false,
    );
    expect(
      scoreQuery({ ...query, must_top5: [] }, ['noise']).noAnswerPassed,
    ).toBeNull();
  });
  it('uses the first required hit for reciprocal rank', () => {
    expect(
      scoreQuery({ ...query, must_top5: ['gold', 'other'] }, [
        'noise',
        'gold',
        'other',
      ]).mrr,
    ).toBe(0.5);
  });
  it('does not let unlabelled queries inflate a failing 95% quality gate', () => {
    const scores = Array.from({ length: 19 }, () =>
      scoreQuery(query, ['gold']),
    );
    scores.push(scoreQuery(query, []), scoreQuery(query, []));
    scores.push(
      ...Array.from({ length: 100 }, () =>
        scoreQuery({ ...query, must_top5: [] }, []),
      ),
    );
    expect(checkThresholds(scores)).toBe(false);
    expect(checkThresholds([])).toBe(false);
  });
});
