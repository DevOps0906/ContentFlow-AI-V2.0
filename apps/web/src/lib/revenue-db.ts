// Mapping and validation for `revenue_rows` (migration 0005).
import { isRevenueRow, rowKey, type RevenueRow } from "./revenue";

export const REVENUE_COLUMNS =
  "source,status,currency,report_date,page,revenue,pageviews,impressions,clicks,created_at";
export const MAX_ROWS_PER_REQUEST = 1000;

export type RevenueDbRow = {
  source: string;
  status: "estimated" | "finalized";
  currency: string;
  report_date: string;
  page: string;
  revenue: number | string | null;
  pageviews: number | string | null;
  impressions: number | string | null;
  clicks: number | string | null;
  created_at: string;
};
// numeric/bigint columns may come back as strings
const num = (v: number | string | null) => (v === null ? null : Number(v));
export const dbToRevenue = (r: RevenueDbRow): RevenueRow => ({
  source: r.source,
  status: r.status,
  currency: r.currency,
  date: r.report_date,
  page: r.page,
  revenue: num(r.revenue),
  pageviews: num(r.pageviews),
  impressions: num(r.impressions),
  clicks: num(r.clicks),
  importedAt: r.created_at,
});

/**
 * Validates rows sent by the browser. The dedupe key is computed here from the row itself:
 * a client can not forge or reuse a key to hide or overwrite another row.
 */
export function parseRevenueBatch(input: unknown): RevenueRow[] {
  const list = (input as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list) || list.length === 0) throw new Error("저장할 수익 행이 없습니다.");
  if (list.length > MAX_ROWS_PER_REQUEST) throw new Error(`한 번에 ${MAX_ROWS_PER_REQUEST}행까지 저장할 수 있습니다.`);
  return list.map((v, i) => {
    if (!isRevenueRow(v)) throw new Error(`${i + 1}번째 행의 형식이 올바르지 않습니다.`);
    if (!/^[A-Z]{3}$/.test(v.currency) || v.source.trim().length === 0 || v.source.length > 40 || v.page.length > 500)
      throw new Error(`${i + 1}번째 행의 출처·통화·페이지가 올바르지 않습니다.`);
    if (v.revenue === null && v.pageviews === null && v.impressions === null && v.clicks === null)
      throw new Error(`${i + 1}번째 행에 값이 없습니다.`);
    return v;
  });
}
export function toDbRows(rows: RevenueRow[], workspaceId: string, userId: string) {
  return rows.map((r) => ({
    workspace_id: workspaceId,
    row_key: rowKey(r),
    source: r.source.trim(),
    status: r.status,
    currency: r.currency,
    report_date: r.date,
    page: r.page,
    revenue: r.revenue,
    pageviews: r.pageviews,
    impressions: r.impressions,
    clicks: r.clicks,
    created_by: userId,
  }));
}