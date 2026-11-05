import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  Bug,
  CalendarDays,
  ChartNoAxesCombined,
  Code2,
  Columns3,
  Feather,
  Landmark,
  ShoppingBag,
  Star,
} from "lucide-react";
import type { Template } from "@/lib/templates";
const icons = {
  book: BookOpen,
  tool: Bug,
  landmark: Landmark,
  compare: Columns3,
  star: Star,
  feather: Feather,
  bag: ShoppingBag,
  calendar: CalendarDays,
  code: Code2,
  chart: ChartNoAxesCombined,
};
export function TemplateCard({
  template,
  compact = false,
}: {
  template: Template;
  compact?: boolean;
}) {
  const Icon = icons[template.icon as keyof typeof icons];
  return (
    <article className={`template-card ${compact ? "compact" : ""}`}>
      <div className={`template-art ${template.color}`}>
        <span className="art-circle" />
        <span className="art-dot" />
        <div className="paper-preview">
          <div className="paper-label" />
          <div className="paper-title" />
          <div className="paper-line" />
          <div className="paper-line short" />
          {template.icon === "compare" ? (
            <div className="paper-columns">
              <span />
              <span />
            </div>
          ) : (
            <>
              <div className="paper-block" />
              <div className="paper-line" />
              <div className="paper-line short" />
            </>
          )}
        </div>
        <span className="template-art-icon">
          <Icon size={23} />
        </span>
        <span className="template-code">{template.id}</span>
      </div>
      <div className="template-card-body">
        <div className="template-category">
          {template.category}
          <span>글쓰기 템플릿</span>
        </div>
        <h3>{template.name}</h3>
        <p>{template.description}</p>
        {!compact && (
          <div className="template-block-count">
            {template.blocks.length}개 구성 블록 <span>·</span> 근거 검수 포함
          </div>
        )}
        <Link
          className="template-use"
          href={`/content/new?template=${template.id}`}
        >
          이 템플릿으로 작성
          <ArrowUpRight size={16} />
        </Link>
      </div>
    </article>
  );
}
