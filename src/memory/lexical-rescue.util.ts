/**
 * ENG-36 F2: gated lexical (ILIKE) rescue for user-scoped recall.
 *
 * The prod rescue, `LOWER(raw) LIKE` over every row of the user, costs
 * ~115–270 ms at 58k rows because it lower-cases and scans each row's text.
 * An unconditional trigram rewrite is fast for rare terms but slow for common
 * ones ("work", "open": the bitmap covers most of the table). ENG-27 measured
 * 528 ms on the SessionStart query.
 *
 * The gated path returns the same top-N as the current query, whichever way the
 * terms fall:
 *   1. Window: take the user's top WINDOW surviving rows in rescue order
 *      (importance DESC, created_at DESC, id) and match only those. If it yields
 *      LIMIT rows, they are exactly the global top LIMIT: any match outside the
 *      window ranks below every row inside it. Common terms finish here.
 *   2. Otherwise the terms are rare (< LIMIT matches per WINDOW rows), so
 *      `raw ILIKE` on the trigram index (idx_memories_raw_trgm) is cheap and
 *      returns the full answer.
 * Terms are [a-z0-9]+ (extractLexicalRescueTerms), so ILIKE and LOWER() LIKE
 * match the same rows and no LIKE metacharacters reach the pattern.
 *
 * Off by default; RECALL_LEXICAL_RESCUE_GATED=true turns it on.
 */
export const LEXICAL_RESCUE_WINDOW = 2000;
export const LEXICAL_RESCUE_LIMIT = 20;

const SURVIVOR_SQL = `deleted_at IS NULL
       AND superseded_by_id IS NULL
       AND searchable IS NOT FALSE
       AND embedding_status != 'DUPLICATE'
       AND is_duplicate_of IS NULL`;

const RESCUE_ORDER = 'ORDER BY importance_score DESC, created_at DESC, id ASC';

export function isGatedLexicalRescueEnabled(): boolean {
  return process.env.RECALL_LEXICAL_RESCUE_GATED === 'true';
}

interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface GatedLexicalRescueResult {
  rows: { id: string }[];
  path: 'window' | 'trigram';
}

export async function gatedLexicalRescue(
  prisma: RawQueryClient,
  userIds: string[],
  words: string[],
): Promise<GatedLexicalRescueResult> {
  const params = words.map((w) => `%${w}%`);
  const like = words.map((_, i) => `LOWER(raw) LIKE $${i + 2}`).join(' OR ');
  const windowRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM (
       SELECT id, raw, importance_score, created_at FROM memories
       WHERE user_id = ANY($1::text[])
       AND ${SURVIVOR_SQL}
       ${RESCUE_ORDER}
       LIMIT ${LEXICAL_RESCUE_WINDOW}
     ) w
     WHERE (${like})
     ${RESCUE_ORDER}
     LIMIT ${LEXICAL_RESCUE_LIMIT}`,
    userIds,
    ...params,
  );
  if (windowRows.length >= LEXICAL_RESCUE_LIMIT) {
    return { rows: windowRows, path: 'window' };
  }

  const ilike = words.map((_, i) => `raw ILIKE $${i + 2}`).join(' OR ');
  const trigramRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM memories
     WHERE user_id = ANY($1::text[])
       AND (${ilike})
       AND ${SURVIVOR_SQL}
     ${RESCUE_ORDER}
     LIMIT ${LEXICAL_RESCUE_LIMIT}`,
    userIds,
    ...params,
  );
  return { rows: trigramRows, path: 'trigram' };
}
