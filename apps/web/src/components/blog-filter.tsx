"use client";
import { useCallback, useEffect, useState } from "react";
import { ALL_BLOGS, blogOptionLabel, UNCLASSIFIED_BLOGS, type Blog, type BlogFilterValue } from "@/lib/blogs";

type Loaded = { blogs: Blog[]; canManage: boolean; loading: boolean; error: string };

/** The accounts of the active workspace. Nothing is requested in local mode. */
export function useBlogs(account: boolean) {
  const [state, setState] = useState<Loaded>({ blogs: [], canManage: false, loading: true, error: "" });
  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/blogs");
      const data = (await res.json().catch(() => null)) as { blogs?: Blog[]; canManage?: boolean; error?: string } | null;
      if (!res.ok || !data?.blogs) throw new Error(data?.error ?? "블로그 계정을 불러오지 못했습니다.");
      setState({ blogs: data.blogs, canManage: data.canManage === true, loading: false, error: "" });
    } catch (e) {
      const error = e instanceof Error ? e.message : "블로그 계정을 불러오지 못했습니다.";
      setState((s) => ({ ...s, loading: false, error }));
    }
  }, []);
  useEffect(() => {
    if (account) reload();
  }, [account, reload]);
  return { ...state, reload };
}

/** Shared blog filter: all, one account (archived ones included), or unclassified. */
export function BlogFilter({
  account,
  value,
  onChange,
  id = "blog-filter",
}: {
  account: boolean;
  value: BlogFilterValue;
  onChange: (value: BlogFilterValue) => void;
  id?: string;
}) {
  const { blogs, error } = useBlogs(account);
  if (!account) return <p className="metric-note">블로그 계정별 보기는 계정 모드에서 사용 가능합니다.</p>;
  return (
    <div className="field blog-filter">
      <label htmlFor={id}>블로그 계정</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={ALL_BLOGS}>전체</option>
        {blogs.map((b) => (
          <option key={b.id} value={b.id}>
            {blogOptionLabel(b)}
          </option>
        ))}
        <option value={UNCLASSIFIED_BLOGS}>미분류</option>
      </select>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
