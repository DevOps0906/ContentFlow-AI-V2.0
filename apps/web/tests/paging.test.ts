import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAll } from "../src/lib/paging";

const source = (n: number) => Array.from({ length: n }, (_, i) => i);
const pager = (n: number, calls: [number, number][] = []) => (from: number, to: number) => {
  calls.push([from, to]);
  return Promise.resolve({ data: source(n).slice(from, to + 1), error: null });
};

test("reads past the 1000-row server limit, with no gaps or repeats", async () => {
  for (const n of [0, 1, 999, 1000, 1001, 2500, 5000]) {
    const rows = await fetchAll<number>(pager(n));
    assert.equal(rows.length, n, `n=${n}`);
    assert.deepEqual(rows, source(n));
  }
});

test("asks for consecutive ranges and stops at the first short page", async () => {
  const calls: [number, number][] = [];
  await fetchAll<number>(pager(2500, calls));
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  const exact: [number, number][] = [];
  await fetchAll<number>(pager(2000, exact));
  assert.deepEqual(exact, [[0, 999], [1000, 1999], [2000, 2999]], "an exactly full last page needs one more empty request");
});

test("errors are raised, never turned into a partial list", async () => {
  await assert.rejects(
    fetchAll<number>((from) =>
      from === 0
        ? Promise.resolve({ data: source(1000), error: null })
        : Promise.resolve({ data: null, error: { message: "boom" } }),
    ),
    /boom/,
  );
  await assert.rejects(fetchAll<number>(pager(10_000), { limit: 3000 }), /too many/);
});
