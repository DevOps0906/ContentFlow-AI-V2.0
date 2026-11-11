"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import {
  COST_ENTRY_DIGITS,
  costCategories,
  costCategoryLabels,
  localDay,
  parseCostEntry,
  RUN_ESTIMATE_DIGITS,
  saveCostEntry,
  type CostCategory,
  type CostEntry,
  type CurrencyTotal,
  type RunEstimates,
} from "@/lib/costs";
import { formatMoney } from "@/lib/revenue";
import { postJson } from "./integrations";
import { ConfirmDialog } from "./dialog";

type Loaded = { entries: CostEntry[]; totals: CurrencyTotal[]; runEstimates: RunEstimates; canRecord: boolean };
const SHOWN = 50;

/** Manual cost ledger. AI call estimates are shown apart and never join a total. */
export function CostLedger({ account }: { account: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState<CostCategory>("hosting");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("KRW");
  const [occurredOn, setOccurredOn] = useState(() => localDay());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [removing, setRemoving] = useState<CostEntry | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/costs", { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (Loaded & { error?: string }) | null;
    if (!res.ok || !body) throw new Error(body?.error ?? "원가 정보를 불러오지 못했습니다.");
    setData(body);
    setError("");
  }, []);
  const reload = useCallback(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "원가 정보를 불러오지 못했습니다."));
  }, [load]);
  useEffect(() => {
    if (account) reload();
  }, [account, reload]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMessage("");
    setBusy(true);
    try {
      const body = parseCostEntry({ category, amount, currency, occurredOn, note });
      setMessage(
        await saveCostEntry({
          save: () => postJson("/api/costs", body),
          clearForm: () => {
            setAmount("");
            setNote("");
          },
          reload: load,
        }),
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: CostEntry) {
    setRemoving(null);
    setMessage("");
    try {
      const res = await fetch(`/api/costs?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "삭제하지 못했습니다.");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "삭제하지 못했습니다.");
    }
  }

  return (
    <section className="panel keywords-panel">
      <h2>제작 원가</h2>
      {!account ? (
        <p className="metric-note">제작 원가 장부는 계정 모드에서 사용 가능합니다.</p>
      ) : error && !data ? (
        <>
          <p role="alert" className="error-banner">
            {error}
          </p>
          <button className="button secondary" onClick={reload}>
            다시 불러오기
          </button>
        </>
      ) : !data ? (
        <p className="metric-note">원가 정보를 불러오고 있어요.</p>
      ) : (
        <>
          <p className="metric-note">
            직접 입력한 금액만 합계에 들어가며, 통화별로 따로 표시합니다. 실제 청구서 금액을 입력해 주세요.
          </p>
          <h3 className="team-heading">입력 원가 합계</h3>
          {data.totals.length === 0 ? (
            <p className="metric-note">N/A · 아직 입력한 원가가 없습니다.</p>
          ) : (
            <ul className="site-check-list">
              {data.totals.map((t) => (
                <li key={t.currency}>
                  <b>{formatMoney(t.total, t.currency, COST_ENTRY_DIGITS)}</b> <span className="metric-note">{t.count}건</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="team-heading">AI 호출 추정 (참고값 · 합계에 포함 안 됨)</h3>
          {data.runEstimates.byCurrency.length === 0 ? (
            <p className="metric-note">N/A · 단가가 설정된 AI 호출 기록이 없습니다.</p>
          ) : (
            <ul className="site-check-list">
              {data.runEstimates.byCurrency.map((t) => (
                <li key={t.currency}>
                  {formatMoney(t.total, t.currency, RUN_ESTIMATE_DIGITS)} <span className="metric-note">{t.count}회</span>
                </li>
              ))}
            </ul>
          )}
          <p className="metric-note">
            AI 호출 {data.runEstimates.runs}회 중 비용을 알 수 없는 호출 {data.runEstimates.unpriced}회. 운영 참고값이며
            청구·정산 근거가 아닙니다.
          </p>
          {data.canRecord ? (
            <form className="ledger-fields" onSubmit={save} noValidate>
              <div className="field">
                <label htmlFor="cost-category">구분</label>
                <select
                  id="cost-category"
                  value={category}
                  disabled={busy}
                  onChange={(e) => setCategory(e.target.value as CostCategory)}
                >
                  {costCategories.map((c) => (
                    <option key={c} value={c}>
                      {costCategoryLabels[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cost-amount">금액</label>
                <input
                  id="cost-amount"
                  inputMode="decimal"
                  value={amount}
                  disabled={busy}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="cost-currency">통화</label>
                <input
                  id="cost-currency"
                  maxLength={3}
                  value={currency}
                  disabled={busy}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </div>
              <div className="field">
                <label htmlFor="cost-date">발생일</label>
                <input
                  id="cost-date"
                  type="date"
                  value={occurredOn}
                  disabled={busy}
                  onChange={(e) => setOccurredOn(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="cost-note">메모</label>
                <input
                  id="cost-note"
                  maxLength={500}
                  value={note}
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <button className="button secondary" type="submit" disabled={busy}>
                {busy ? "기록 중…" : "원가 기록"}
              </button>
            </form>
          ) : (
            <p className="metric-note">원가는 소유자·관리자만 기록할 수 있어요. 지금은 볼 수만 있어요.</p>
          )}
          {message && (
            <p role="status" className="metric-note">
              {message}
            </p>
          )}
          {data.entries.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">발생일</th>
                    <th scope="col">구분</th>
                    <th scope="col">금액</th>
                    <th scope="col">메모</th>
                    {data.canRecord && <th scope="col">관리</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.entries.slice(0, SHOWN).map((c) => (
                    <tr key={c.id}>
                      <td>{c.occurredOn}</td>
                      <td>{costCategoryLabels[c.category]}</td>
                      <td>{formatMoney(c.amount, c.currency, COST_ENTRY_DIGITS)}</td>
                      <td>{c.note ?? ""}</td>
                      {data.canRecord && (
                        <td>
                          <button className="button secondary" aria-label={`${c.occurredOn} 원가 삭제`} onClick={() => setRemoving(c)}>
                            <Trash2 size={14} /> 삭제
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.entries.length > SHOWN && <p className="metric-note">최근 {SHOWN}건만 표시합니다. 합계는 전체 기준입니다.</p>}
        </>
      )}
      {removing && (
        <ConfirmDialog
          title="이 원가 기록을 삭제할까요?"
          description={`${removing.occurredOn} · ${formatMoney(removing.amount, removing.currency, COST_ENTRY_DIGITS)} 기록이 합계에서 빠집니다.`}
          danger
          confirmLabel="삭제"
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </section>
  );
}
