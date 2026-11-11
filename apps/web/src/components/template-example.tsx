"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eye, ImageIcon, X } from "lucide-react";
import { findTemplate } from "@/lib/templates";
import {
  EXAMPLE_IMAGE_DIR,
  EXAMPLE_NOTICE,
  IMAGE_NOTICE,
  findTemplateExample,
  hasExampleImage,
} from "@/lib/template-examples";

const FOCUSABLE = "button:not([disabled]), a[href]";

/** "예시 보기" 버튼 + 대화상자. onUse가 없으면 새 콘텐츠 작성 링크를 쓴다. */
export function TemplateExampleButton({
  templateId,
  onUse,
  className = "button secondary",
}: {
  templateId: string;
  onUse?: (templateId: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!findTemplateExample(templateId)) return null;
  function close() {
    setOpen(false);
    // 닫힌 뒤 열었던 버튼으로 포커스를 돌려준다.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Eye size={14} /> 예시 보기
      </button>
      {open && (
        <TemplateExampleDialog
          templateId={templateId}
          onClose={close}
          onUse={
            onUse
              ? () => {
                  onUse(templateId);
                  close();
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function TemplateExampleDialog({
  templateId,
  onClose,
  onUse,
}: {
  templateId: string;
  onClose: () => void;
  onUse?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const template = findTemplate(templateId);
  const example = findTemplateExample(templateId);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  if (!example) return null;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="example-title"
        className="dialog example-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const els = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
            if (!els?.length) return;
            const first = els[0];
            const last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="example-head">
          <div>
            <span className="example-badge">{EXAMPLE_NOTICE}</span>
            <h2 id="example-title">{example.title}</h2>
            <p className="example-meta">
              {template.id} · {template.name}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="예시 닫기"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="example-body">
          {example.sections.map((s) => (
            <section key={s.block}>
              <h3>{s.block}</h3>
              {s.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {s.items && (
                <ul>
                  {s.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
              {s.image && (
                <figure>
                  {hasExampleImage(s.image.file) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`${EXAMPLE_IMAGE_DIR}${s.image.file}`}
                      alt={s.image.alt}
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className="example-placeholder"
                      role="img"
                      aria-label={`${s.image.alt} (예시 이미지 준비 중)`}
                    >
                      <ImageIcon size={28} />
                      <b>{s.image.alt}</b>
                      <span>예시 이미지 준비 중</span>
                    </div>
                  )}
                  <figcaption>
                    {s.image.caption}{" "}
                    {hasExampleImage(s.image.file) && (
                      <span>· {IMAGE_NOTICE}</span>
                    )}
                  </figcaption>
                </figure>
              )}
            </section>
          ))}
        </div>
        <div className="editor-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            닫기
          </button>
          {onUse ? (
            <button type="button" className="button primary" onClick={onUse}>
              이 템플릿으로 작성
            </button>
          ) : (
            <Link
              className="button primary"
              href={`/content/new?template=${template.id}`}
            >
              이 템플릿으로 작성
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
