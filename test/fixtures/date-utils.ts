/**
 * Date utilities for fixtures.
 * Uses a fixed reference date so fixtures are deterministic.
 */

/** Fixed reference: 2026-03-10T00:00:00Z */
const REFERENCE_DATE = new Date('2026-03-10T00:00:00Z');

export function subDays(days: number): Date {
  const d = new Date(REFERENCE_DATE);
  d.setDate(d.getDate() - days);
  return d;
}

export function subMonths(months: number): Date {
  const d = new Date(REFERENCE_DATE);
  d.setMonth(d.getMonth() - months);
  return d;
}

export function subYears(years: number): Date {
  const d = new Date(REFERENCE_DATE);
  d.setFullYear(d.getFullYear() - years);
  return d;
}
