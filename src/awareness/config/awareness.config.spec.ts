import { CronTime } from 'cron';

describe('AwarenessConfig', () => {
  const originalEnv = process.env.AWARENESS_SCHEDULE;

  afterEach(() => {
    jest.resetModules();
    if (originalEnv === undefined) {
      delete process.env.AWARENESS_SCHEDULE;
    } else {
      process.env.AWARENESS_SCHEDULE = originalEnv;
    }
  });

  it('defaults to every 4 hours, not every 4 minutes', () => {
    delete process.env.AWARENESS_SCHEDULE;

    const { DEFAULT_AWARENESS_SCHEDULE, AwarenessConfig } = require('./awareness.config');

    expect(AwarenessConfig.schedule).toBe(DEFAULT_AWARENESS_SCHEDULE);
    expect(nextRunHours(AwarenessConfig.schedule)).toEqual([8, 12, 16, 20]);
  });

  it('still allows operators to override the schedule by env var', () => {
    process.env.AWARENESS_SCHEDULE = '0 30 9 * * *';

    const { AwarenessConfig } = require('./awareness.config');

    expect(AwarenessConfig.schedule).toBe('0 30 9 * * *');
  });
});

function nextRunHours(schedule: string): number[] {
  const cron = new CronTime(schedule);
  let cursor = new Date('2026-06-20T07:59:59-07:00');

  return Array.from({ length: 4 }, () => {
    const next = cron.getNextDateFrom(cursor).toJSDate();
    cursor = new Date(next.getTime() + 1000);
    return next.getHours();
  });
}
