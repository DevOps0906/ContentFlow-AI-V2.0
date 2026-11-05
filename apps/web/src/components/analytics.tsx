"use client";
import {
  ChartNoAxesCombined,
  FileSpreadsheet,
  Globe,
  Link2,
  Wallet,
} from "lucide-react";
import { PageHeading } from "./shell";
import { useWorkspace } from "./workspace";
export function Analytics() {
  const { articles } = useWorkspace();
  return (
    <>
      <PageHeading
        eyebrow="UNDERSTAND YOUR GROWTH"
        title="수익 분석"
        description="검색 유입, 광고 수익, 제작 비용을 같은 기준으로 살펴보는 공간입니다."
      />
      <div className="stats-grid">
        {[
          { label: "광고 예상 수익", value: "—", note: "광고 보고서 미연결" },
          {
            label: "페이지 RPM",
            value: "—",
            note: "동일 보고서의 수익과 조회수 필요",
          },
          { label: "콘텐츠 제작비", value: "—", note: "원가 데이터 미입력" },
          {
            label: "로컬 콘텐츠",
            value: String(articles.length),
            note: "현재 브라우저에 저장된 원고",
          },
        ].map((m) => (
          <article className="stat-card" key={m.label}>
            <div className="stat-top">
              {m.label}
              <Wallet size={17} />
            </div>
            <div className="stat-value">{m.value}</div>
            <p>{m.note}</p>
          </article>
        ))}
      </div>
      <section className="panel analytics-empty">
        <span className="empty-icon">
          <ChartNoAxesCombined size={27} />
        </span>
        <h2>실제 데이터를 연결하면, 성장이 보입니다.</h2>
        <p>
          아직 광고·검색 데이터 연동이 구현되지 않았습니다. 현재 수익을 0원으로
          추정하거나 샘플 수치를 실적처럼 표시하지 않습니다.
        </p>
      </section>
      <div className="analytics-columns">
        {[
          {
            icon: Globe,
            title: "검색 성과",
            text: "Search Console의 노출·클릭·검색 CTR을 출처와 기간별로 확인할 예정입니다.",
          },
          {
            icon: FileSpreadsheet,
            title: "광고 보고서",
            text: "AdSense 보고서의 예상 수익과 정산 확정액을 구분하고 중복 수입을 방지할 예정입니다.",
          },
          {
            icon: Link2,
            title: "글별 수익과 원가",
            text: "URL로 귀속 가능한 수익을 연결하고 제작·편집·운영 비용과 함께 확인할 예정입니다.",
          },
        ].map((c) => (
          <section className="panel info-card" key={c.title}>
            <span className="stat-icon mint">
              <c.icon size={19} />
            </span>
            <h3>{c.title}</h3>
            <p>{c.text}</p>
            <span className="subtle-chip">연동 준비 중</span>
          </section>
        ))}
      </div>
      <p className="metric-note">
        관측 예상 수익 · 확정 정산 · 모델 추정은 별도입니다. 광고 승인이나 수익
        증가를 보장하지 않습니다.
      </p>
    </>
  );
}
