/**
 * Deduplication DTOs — re-export barrel.
 *
 * Previously a single 639-line file; split for maintainability:
 *   - deduplication-enums.ts      — shared enums
 *   - deduplication-request.dto.ts — request/input DTOs
 *   - deduplication-response.dto.ts — response/output DTOs
 *
 * All existing imports from './dto/deduplication.dto' continue to work unchanged.
 */

export * from './deduplication-enums';
export * from './deduplication-request.dto';
export * from './deduplication-response.dto';
