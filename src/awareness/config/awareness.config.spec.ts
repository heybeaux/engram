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
    expect(configuredHours(AwarenessConfig.schedule)).toEqual([8, 12, 16, 20]);
    expect(configuredMinutes(AwarenessConfig.schedule)).toEqual([0]);
  });

  it('still allows operators to override the schedule by env var', () => {
    process.env.AWARENESS_SCHEDULE = '0 30 9 * * *';

    const { AwarenessConfig } = require('./awareness.config');

    expect(AwarenessConfig.schedule).toBe('0 30 9 * * *');
  });
});

function configuredMinutes(schedule: string): number[] {
  return parseCronField(schedule, 1);
}

function configuredHours(schedule: string): number[] {
  return parseCronField(schedule, 2);
}

function parseCronField(schedule: string, fieldIndex: number): number[] {
  return schedule
    .split(/\s+/)
    [fieldIndex].split(',')
    .map((value) => Number(value));
}
