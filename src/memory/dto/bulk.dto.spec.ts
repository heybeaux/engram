import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BulkCreateMemoryDto } from './bulk.dto';

describe('BulkCreateMemoryDto', () => {
  // T5a Part B: observedAt validator (IsISO8601 + ObservedAtNotFarFutureConstraint)
  // must be wired on bulk items in parity with CreateMemoryDto.
  it('rejects observedAt more than 1 hour in the future', async () => {
    const tenHoursFromNow = new Date(
      Date.now() + 10 * 60 * 60 * 1000,
    ).toISOString();

    const dto = plainToInstance(BulkCreateMemoryDto, {
      memories: [
        {
          raw: 'A memory',
          observedAt: tenHoursFromNow,
        },
      ],
    });

    const errors = await validate(dto);
    // The error surfaces on the nested item — flatten and verify it's the
    // observedAt constraint, not some other rule.
    const flat = JSON.stringify(errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(flat).toMatch(/observedAt/);
    expect(flat).toMatch(/1 hour in the future|ObservedAtNotFarFuture/i);
  });

  it('accepts observedAt in the past', async () => {
    const dto = plainToInstance(BulkCreateMemoryDto, {
      memories: [
        {
          raw: 'A historical memory',
          source: 'HISTORICAL',
          observedAt: '2024-01-15T14:00:00Z',
        },
      ],
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
