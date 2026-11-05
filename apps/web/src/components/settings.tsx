"use client";
import { useState } from "react";
import { Download, ExternalLink, Trash2 } from "lucide-react";
import { useWorkspace, download } from "./workspace";
import { STORAGE_KEY } from "@/lib/content";
import { PageHeading } from "./shell";
import { ConfirmDialog } from "./dialog";
export function Settings() {
  const { articles, clear } = useWorkspace();
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <>
      <PageHeading
        eyebrow="YOUR WORKSPACE"
        title="워크스페이스 설정"
        description="작업 환경과 로컬 콘텐츠의 보관 상태를 확인하세요."
      />
      <section className="panel settings-panel">
        <h2>나의 블로그 스튜디오</h2>
        <dl className="detail-list">
          <dt>운영 모드</dt>
          <dd>로컬 · 이 브라우저에서만 저장</dd>
          <dt>콘텐츠</dt>
          <dd>{articles.length}개</dd>
          <dt>글쓰기 템플릿</dt>
          <dd>10종 · 콘텐츠 작성 화면에서 선택</dd>
          <dt>외부 연결</dt>
          <dd>로그인 / CMS / AI / 광고 API 미연결</dd>
        </dl>
        <p>
          공유 기기에서는 콘텐츠가 다른 사용자에게 보일 수 있습니다. 다른 기기로
          이동하기 전에 백업하고, 민감한 원고는 저장하지 마세요.
        </p>
      </section>
      <section className="panel settings-panel">
        <h2>콘텐츠 백업</h2>
        <p>
          원고와 템플릿 선택, 검수 상태를 JSON 파일로 보관합니다. 현재 화면의
          초기화와 별개로 내려받은 파일은 유지됩니다. JSON 가져오기는 아직
          지원하지 않습니다.
        </p>
        <div className="editor-actions">
          <button
            className="button secondary"
            onClick={() => {
              try {
                const raw = localStorage.getItem(STORAGE_KEY) ?? "[]";
                download("contentflow-backup.json", raw, "application/json");
                setMessage("브라우저 원본 데이터를 백업했어요.");
              } catch {
                setMessage("저장소 접근에 실패했습니다.");
              }
            }}
          >
            <Download size={16} />
            JSON 백업
          </button>
          <button className="button danger" onClick={() => setConfirm(true)}>
            <Trash2 size={15} />
            로컬 데이터 초기화
          </button>
        </div>
        {message && (
          <p role="status" className="metric-note">
            {message}
          </p>
        )}
      </section>
      <section className="panel settings-panel">
        <h2>프로젝트 안내</h2>
        <p>
          현재 버전은 템플릿 선택·원고 작성·수동 검수·HTML 내보내기를 제공하는
          프런트엔드입니다. 서버 저장, 사용자 인증, WordPress API 초안 생성과
          광고 데이터 수집은 후속 단계입니다.
        </p>
        <a
          className="view-link"
          target="_blank"
          rel="noreferrer"
          href="https://github.com/DevOps0906/ContentFlow-AI-V2.0"
        >
          저장소와 기획 문서 보기
          <ExternalLink size={13} />
        </a>
      </section>
      {confirm && (
        <ConfirmDialog
          title="모든 로컬 콘텐츠를 초기화할까요?"
          description="현재 브라우저의 모든 원고가 삭제됩니다. 먼저 JSON 백업을 내려받았는지 확인해주세요."
          danger
          confirmLabel="모두 초기화"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            if (clear()) {
              setConfirm(false);
              setMessage("로컬 데이터를 초기화했어요.");
            }
          }}
        />
      )}
    </>
  );
}
