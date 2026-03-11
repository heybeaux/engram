/**
 * Date utilities for fixtures.
 * Uses a fixed reference date so fixtures are deterministic.
 */

/** Dynamic reference: current time so relative dates stay accurate across test runs */
const REFERENCE_DATE = new Date();

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
