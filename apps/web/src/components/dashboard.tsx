"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  FileText,
  LayoutTemplate,
  Plus,
  Sparkles,
  Wallet,
} from "lucide-react";
import { templates } from "@/lib/templates";
import { isApprovedContent, templateName } from "@/lib/content";
import { useWorkspace } from "./workspace";
import { dayKey, formatDate, lastDayKeys, shortDay } from "@/lib/date";
import { NewContentButton, PageHeading } from "./shell";
import { TemplateCard } from "./template-card";
import { StatusBadge } from "./status-badge";

export function Dashboard() {
  const { articles, ready, mode } = useWorkspace();
  const approved = articles.filter(isApprovedContent).length;
  const reviewing = articles.filter((a) =>
    ["qa_pending", "approval_pending"].includes(a.status),
  ).length;
  const days = lastDayKeys(7);
  const counts = days.map((d) => articles.filter((a) => dayKey(a.updatedAt) === d).length);
  const max = Math.max(4, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const steps = [
    {
      label: "첫 콘텐츠 만들기",
      done: articles.length > 0,
      href: "/content/new",
    },
    {
      label: "출처 확인 후 검수 요청",
      done: articles.some(
        (a) => a.status === "approval_pending" || isApprovedContent(a),
      ),
      href: "/content",
    },
    { label: "원고 승인하고 내보내기", done: approved > 0, href: "/content" },
  ];
  return (
    <>
      <PageHeading
        eyebrow="YOUR CONTENT, IN FLOW"
        title="오늘도, 좋은 콘텐츠를 만들어요 👋"
        description="아이디어부터 발행 준비까지. 블로그 운영의 흐름을 한눈에 확인하세요."
        action={<NewContentButton />}
      />
      <section className="welcome-banner">
        <div>
          <span className="banner-label">
            <Sparkles size={14} />
            조금 더 가벼운 글쓰기
          </span>
          <h2>
            빈 화면 대신,
            <br className="mobile-only" /> 잘 짜인 구조에서 시작하세요.
          </h2>
          <p>목적에 맞는 템플릿을 고르면, 다음 문장이 쉬워집니다.</p>
          <Link href="/templates" className="button dark">
            템플릿 살펴보기
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className="banner-illustration" aria-hidden="true">
          <div className="floating-label">
            <Check size={12} />
            나만의 콘텐츠 완성
          </div>
          <div className="banner-paper back" />
          <div className="banner-paper">
            <span className="paper-badge">
              <Sparkles size={16} />
            </span>
            <b>좋은 글의 시작</b>
            <i />
            <i />
            <i className="short" />
            <div className="banner-paper-block">
              <span />
              <span />
              <span />
            </div>
          </div>
          <span className="float-sparkle">✦</span>
        </div>
      </section>
      <section className="stats-grid" aria-label="콘텐츠 현황">
        <Stat
          title="전체 콘텐츠"
          value={ready ? String(articles.length) : "—"}
          unit="개"
          note={mode === "account" ? "내 계정에 저장한 콘텐츠" : "이 브라우저에 저장한 콘텐츠"}
          icon={<FileText size={19} />}
          color="blue"
        />
        <Stat
          title="검수 대기"
          value={ready ? String(reviewing) : "—"}
          unit="개"
          note="근거 확인을 기다리고 있어요"
          icon={<Clock3 size={19} />}
          color="amber"
        />
        <Stat
          title="승인 완료"
          value={ready ? String(approved) : "—"}
          unit="개"
          note="게시·사후 관리 포함 · HTML로 내보낼 수 있어요"
          icon={<CircleCheck size={19} />}
          color="mint"
        />
        <Stat
          title="광고 수익"
          value="—"
          note="광고 데이터 연결이 필요해요"
          icon={<Wallet size={19} />}
          color="purple"
        />
      </section>
      <div className="overview-grid">
        <section className="panel activity-panel">
          <div className="section-heading">
            <div>
              <h2>콘텐츠 활동</h2>
              <p>최근 7일 · 콘텐츠별 마지막 저장일 기준</p>
            </div>
            <span className="subtle-chip">이번 주</span>
          </div>
          <div className="activity-total">
            {total}
            <span>개의 콘텐츠를 다듬었어요</span>
          </div>
          <div
            className="bar-chart"
            role="img"
            aria-label={`최근 7일 저장된 콘텐츠 수: ${counts.join(", ")}`}
          >
            <div className="chart-guides">
              <span>{max}</span>
              <span>{Math.round(max / 2)}</span>
              <span>0</span>
            </div>
            <div className="chart-bars">
              {days.map((day, i) => (
                <div className="chart-column" key={day}>
                  <div className="bar-track">
                    <div
                      className={`chart-bar ${i === 6 ? "today" : ""}`}
                      style={{ height: `${(counts[i] / max) * 100}%` }}
                    >
                      {counts[i] > 0 && <span>{counts[i]}</span>}
                    </div>
                  </div>
                  <span className={i === 6 ? "today-label" : ""}>
                    {shortDay(day)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {articles.length === 0 && (
            <p className="chart-empty">
              첫 콘텐츠를 저장하면 활동이 여기에 쌓여요.
            </p>
          )}
        </section>
        <section className="panel start-panel">
          <div className="section-heading">
            <div>
              <h2>나의 첫 발행 준비</h2>
              <p>세 단계로 시작하는 콘텐츠 운영</p>
            </div>
            <span className="progress-fraction">
              {steps.filter((s) => s.done).length}
              <small> / 3</small>
            </span>
          </div>
          <div className="progress-track">
            <div
              style={{
                width: `${(steps.filter((s) => s.done).length / 3) * 100}%`,
              }}
            />
          </div>
          <div className="onboarding-steps">
            {steps.map((step, i) => (
              <Link href={step.href} key={step.label}>
                <span className={`step-circle ${step.done ? "done" : ""}`}>
                  {step.done ? <Check size={13} /> : i + 1}
                </span>
                <span>{step.label}</span>
                <ChevronRight size={15} />
              </Link>
            ))}
          </div>
          <div className="note-box">
            <span className="online-dot" />
            <p>
              {mode === "account" ? "계정에 저장되는 작업 공간입니다." : "지금은 로컬 작업 공간입니다."}
              <br />
              실제 블로그 발행은 직접 진행해주세요.
            </p>
          </div>
        </section>
      </div>
      <section className="panel recent-panel">
        <div className="section-heading">
          <div>
            <h2>
              최근 콘텐츠<span className="count-badge">{articles.length}</span>
            </h2>
            <p>아이디어가 글이 되어가는 과정</p>
          </div>
          <Link href="/content" className="text-link">
            전체 보기
            <ArrowRight size={15} />
          </Link>
        </div>
        {articles.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>콘텐츠 제목</th>
                  <th>템플릿</th>
                  <th>상태</th>
                  <th>최근 수정</th>
                  <th>
                    <span className="sr-only">열기</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {articles.slice(0, 4).map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link
                        href={`/content/${a.id}`}
                        className="article-title-link"
                      >
                        <span className="article-file">
                          <FileText size={17} />
                        </span>
                        {a.title || "제목 없는 콘텐츠"}
                      </Link>
                    </td>
                    <td>{templateName(a)}</td>
                    <td>
                      <StatusBadge state={a.status} />
                    </td>
                    <td>{formatDate(a.updatedAt)}</td>
                    <td>
                      <Link
                        href={`/content/${a.id}`}
                        aria-label={`${a.title} 편집`}
                      >
                        <ArrowUpRight size={16} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-recent">
            <span className="empty-icon">
              <FileText size={23} />
            </span>
            <div>
              <h3>첫 번째 콘텐츠를 기다리고 있어요</h3>
              <p>아이디어 하나면 충분해요. 템플릿으로 시작해보세요.</p>
            </div>
            <Link href="/content/new" className="button secondary small">
              <Plus size={15} />
              콘텐츠 만들기
            </Link>
          </div>
        )}
      </section>
      <section className="recommended">
        <div className="section-heading">
          <div>
            <div className="section-kicker">
              <LayoutTemplate size={15} />
              시작을 돕는 글쓰기 도구
            </div>
            <h2>이런 템플릿은 어때요?</h2>
          </div>
          <Link href="/templates" className="text-link">
            템플릿 10종 모두 보기
            <ArrowRight size={15} />
          </Link>
        </div>
        <div className="template-grid recommended-grid">
          {[templates[0], templates[1], templates[3]].map((t) => (
            <TemplateCard key={t.id} template={t} compact />
          ))}
        </div>
      </section>
    </>
  );
}
function Stat({
  title,
  value,
  unit,
  note,
  icon,
  color,
}: {
  title: string;
  value: string;
  unit?: string;
  note: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <article className="stat-card">
      <div className="stat-top">
        <span>{title}</span>
        <span className={`stat-icon ${color}`}>{icon}</span>
      </div>
      <div className="stat-value">
        {value}
        <span>{unit}</span>
      </div>
      <p>{note}</p>
    </article>
  );
}
