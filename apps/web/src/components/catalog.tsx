"use client";
import { useState } from "react";
import { Info, Search, SearchX } from "lucide-react";
import { templates } from "@/lib/templates";
import { PageHeading, NewContentButton } from "./shell";
import { TemplateCard } from "./template-card";
export function Catalog() {
  const [category, setCategory] = useState("전체");
  const [query, setQuery] = useState("");
  const categories = ["전체", ...new Set(templates.map((t) => t.category))];
  const filtered = templates.filter(
    (t) =>
      (category === "전체" || t.category === category) &&
      `${t.name} ${t.description} ${t.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        eyebrow="A BETTER START"
        title="템플릿 라이브러리"
        description="쓰고 싶은 글에 맞는 구조를 고르세요. 나만의 근거와 경험으로 완성할 수 있어요."
        action={<NewContentButton />}
      />
      <div className="notice-banner">
        <Info size={17} />
        <div>
          <b>템플릿은 콘텐츠 화면에서도 선택할 수 있어요.</b>원하는 템플릿을
          고르면 새 콘텐츠에 본문 골격이 적용됩니다. 블로그 스킨과 광고 코드는
          포함하지 않습니다.
        </div>
      </div>
      <div className="toolbar">
        <div className="filter-tabs" role="group" aria-label="템플릿 분류">
          {categories.map((c) => (
            <button
              key={c}
              className={`filter-tab ${category === c ? "selected" : ""}`}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c}
              {c === "전체" && <span>10</span>}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="템플릿 검색"
            placeholder="템플릿 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {filtered.length ? (
        <div className="template-grid">
          {filtered.map((t) => (
            <TemplateCard key={t.id} template={t} />
          ))}
        </div>
      ) : (
        <div className="panel empty-state">
          <SearchX size={30} />
          <h2>일치하는 템플릿이 없어요</h2>
          <p>다른 검색어나 분류로 찾아보세요.</p>
          <button
            className="button secondary"
            onClick={() => {
              setCategory("전체");
              setQuery("");
            }}
          >
            필터 초기화
          </button>
        </div>
      )}
      <p className="catalog-footer">
        {filtered.length}개 템플릿 · 구성은 가볍게, 콘텐츠는 나답게.
      </p>
    </>
  );
}
