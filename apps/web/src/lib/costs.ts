// Production cost ledger (migration 0012). Only operator-entered rows count towards a total.
// AI call estimates (`agent_runs`) are a separate reference: they are summarised on their own and
// never added here, so one model bill can not be counted twice. Currencies are never summed.

export const costCategories = ["model", "labor", "hosting", "renewal", "other"] as const;
export type CostCategory = (typeof costCategories)[number];
export const costCategoryLabels: Record<CostCategory, string> = {
  model: "AI 모델 청구",
  labor: "노동",
  hosting: "호스팅",
  renewal: "도메인·구독 갱신",
  other: "기타",
};

export type CostInput = {
  category: CostCategory;
  amount: number;
  currency: string;
  occurredOn: string;
  note: string | null;
};
export type CostEntry = CostInput & { id: string; createdAt: string };

const MAX_AMOUNT = 99_999_999_999_999;

function parseAmount(v: unknown): number {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : "";
  if (!/^\d+(\.\d{1,4})?$/.test(s)) throw new Error("금액은 소수 넷째 자리까지의 숫자로 입력해주세요.");
  const n = Number(s);
  if (n <= 0 || n > MAX_AMOUNT) throw new Error("금액은 0보다 크고 허용 범위 안이어야 합니다.");
  return n;
}

export function parseDay(v: unknown, label: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s)
    throw new Error(`${label}은(는) YYYY-MM-DD 날짜여야 합니다.`);
  if (s < "2000-01-01" || s > "2100-01-01") throw new Error(`${label}이(가) 허용 범위를 벗어났습니다.`);
  return s;
}

/** Today's date on the operator's clock, as YYYY-MM-DD. */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Fraction digits the columns keep: cost_entries.amount and agent_runs.cost_estimate. */
export const COST_ENTRY_DIGITS = 4;
export const RUN_ESTIMATE_DIGITS = 8;

/**
 * Stores an entry and refreshes the list, and returns what to tell the operator. The form is cleared
 * as soon as the row exists, so a failed refresh can not invite a second save of the same cost.
 */
/** Shown as a toast; every other result of saveCostEntry is an error or a warning and stays inline. */
export const COST_SAVED = "기록했어요.";
export async function saveCostEntry(steps: {
  save: () => Promise<unknown>;
  clearForm: () => void;
  reload: () => Promise<unknown>;
}): Promise<string> {
  try {
    await steps.save();
  } catch (err) {
    // What the operator typed stays in the form so the save can be retried.
    return err instanceof Error ? err.message : "저장하지 못했습니다.";
  }
  steps.clearForm();
  try {
    await steps.reload();
    return COST_SAVED;
  } catch {
    return "기록했지만 목록을 새로 불러오지 못했어요. 다시 입력하지 말고 페이지를 새로고침해 주세요.";
  }
}

/** Validates what the browser sent. Workspace, author and provenance are never taken from it. */
export function parseCostEntry(input: unknown, now = new Date()): CostInput {
  const r = (input ?? {}) as Record<string, unknown>;
  const category = r.category as CostCategory;
  if (!costCategories.includes(category)) throw new Error("원가 구분을 선택해주세요.");
  const amount = parseAmount(r.amount);
  const currency = typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("통화는 KRW, USD 같은 3글자 코드여야 합니다.");
  const occurredOn = parseDay(r.occurredOn, "발생일");
  if (new Date(`${occurredOn}T00:00:00Z`).getTime() > now.getTime() + 2 * 86_400_000)
    throw new Error("발생일은 미래 날짜일 수 없습니다.");
  const note = typeof r.note === "string" ? r.note.trim() : "";
  if (note.length > 500) throw new Error("메모는 500자까지 쓸 수 있습니다.");
  return { category, amount, currency, occurredOn, note: note || null };
}

export const toDbCost = (c: CostInput, workspaceId: string, userId: string) => ({
  workspace_id: workspaceId,
  category: c.category,
  amount: c.amount,
  currency: c.currency,
  occurred_on: c.occurredOn,
  note: c.note,
  created_by: userId,
});

export const COST_COLUMNS = "id,category,amount,currency,occurred_on,note,created_at";
export type CostDbRow = {
  id: string;
  category: CostCategory;
  amount: number | string;
  currency: string;
  occurred_on: string;
  note: string | null;
  created_at: string;
};
export const dbToCost = (r: CostDbRow): CostEntry => ({
  id: r.id,
  category: r.category,
  amount: Number(r.amount),
  currency: r.currency,
  occurredOn: r.occurred_on,
  note: r.note,
  createdAt: r.created_at,
});

export type CurrencyTotal = { currency: string; total: number; count: number };

function totalsByCurrency(rows: { amount: number; currency: string }[], scale: number): CurrencyTotal[] {
  const map = new Map<string, { units: number; count: number }>();
  for (const r of rows) {
    const cur = map.get(r.currency) ?? { units: 0, count: 0 };
    cur.units += Math.round(r.amount * scale); // integer units: 0.1 + 0.2 stays 0.3
    cur.count++;
    map.set(r.currency, cur);
  }
  return [...map.entries()]
    .map(([currency, v]) => ({ currency, total: v.units / scale, count: v.count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Ledger totals, one per currency. An empty ledger has no totals (N/A, not 0). */
export const summarizeCosts = (entries: Pick<CostEntry, "amount" | "currency">[]) => totalsByCurrency(entries, 1e4);

export const AGENT_RUN_COST_COLUMNS = "id,cost_estimate,cost_currency";
export type AgentRunCostRow = { id: string; cost_estimate: number | string | null; cost_currency: string | null };
export type RunEstimates = { runs: number; unpriced: number; byCurrency: CurrencyTotal[] };

/** Reference only: a run with no usage or price stays out of the total and is counted as unpriced. */
export function summarizeRunEstimates(rows: AgentRunCostRow[]): RunEstimates {
  const priced = rows.flatMap((r) =>
    r.cost_estimate === null || r.cost_currency === null
      ? []
      : [{ amount: Number(r.cost_estimate), currency: r.cost_currency }],
  );
  return { runs: rows.length, unpriced: rows.length - priced.length, byCurrency: totalsByCurrency(priced, 1e8) };
}
