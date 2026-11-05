// PostgREST answers at most `max_rows` rows (1000 by default) per request and does not say
// that it cut the list. Anything that may exceed that must be read page by page.
export type Page<T> = PromiseLike<{ data: T[] | null; error: { message?: string } | null }>;

/**
 * Reads every row by asking for consecutive ranges until a short page comes back.
 * `limit` is a safety stop so a bug can not loop forever; reaching it is reported as an error
 * rather than returning a silently truncated list.
 */
export async function fetchAll<T>(
  page: (from: number, to: number) => Page<T>,
  opts: { pageSize?: number; limit?: number } = {},
): Promise<T[]> {
  const size = opts.pageSize ?? 1000;
  const limit = opts.limit ?? 50_000;
  const out: T[] = [];
  for (let from = 0; from < limit; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message ?? "query failed");
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) return out;
  }
  throw new Error("too many rows to read");
}