import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ImportMemoryItemDto } from './export-import.dto';

describe('ImportMemoryItemDto', () => {
  // T5a: observedAt validator must match CreateMemoryDto parity.
  it('rejects observedAt more than 1 hour in the future', async () => {
    const tenHoursFromNow = new Date(
      Date.now() + 10 * 60 * 60 * 1000,
    ).toISOString();

    const dto = plainToInstance(ImportMemoryItemDto, {
      raw: 'A memory to import',
      observedAt: tenHoursFromNow,
    });

    const errors = await validate(dto);
    const flat = JSON.stringify(errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(flat).toMatch(/observedAt/);
    expect(flat).toMatch(/1 hour in the future|ObservedAtNotFarFuture/i);
  });

  it('accepts observedAt in the past', async () => {
    const dto = plainToInstance(ImportMemoryItemDto, {
      raw: 'An old memory',
      observedAt: '2024-01-15T14:00:00Z',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts item without observedAt', async () => {
    const dto = plainToInstance(ImportMemoryItemDto, {
      raw: 'A memory with no anchor',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
