import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { QueryMemoryDto } from './query-memory.dto';

function make(overrides: Partial<Record<string, any>> = {}): QueryMemoryDto {
  return plainToInstance(QueryMemoryDto, {
    query: 'test query',
    ...overrides,
  });
}

describe('QueryMemoryDto — sessionId field (HEY-578)', () => {
  it('accepts a valid sessionId string', async () => {
    const dto = make({ sessionId: 'session_abc123' });
    const errors = await validate(dto);
    expect(errors.filter((e) => e.property === 'sessionId')).toHaveLength(0);
    expect(dto.sessionId).toBe('session_abc123');
  });

  it('is optional — no error when omitted', async () => {
    const dto = make();
    const errors = await validate(dto);
    expect(errors.filter((e) => e.property === 'sessionId')).toHaveLength(0);
    expect(dto.sessionId).toBeUndefined();
  });

  it('rejects sessionId exceeding 256 characters', async () => {
    const dto = make({ sessionId: 'x'.repeat(257) });
    const errors = await validate(dto);
    const sessionIdErrors = errors.filter((e) => e.property === 'sessionId');
    expect(sessionIdErrors.length).toBeGreaterThan(0);
  });

  it('accepts sessionId of exactly 256 characters', async () => {
    const dto = make({ sessionId: 'x'.repeat(256) });
    const errors = await validate(dto);
    expect(errors.filter((e) => e.property === 'sessionId')).toHaveLength(0);
  });

  it('rejects non-string sessionId (number)', async () => {
    const dto = make({ sessionId: 42 });
    const errors = await validate(dto);
    const sessionIdErrors = errors.filter((e) => e.property === 'sessionId');
    expect(sessionIdErrors.length).toBeGreaterThan(0);
  });
});
