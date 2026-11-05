"use client";
import { useEffect, useState } from "react";
import { Download, ExternalLink, Trash2 } from "lucide-react";
import { useWorkspace, download } from "./workspace";
import { LEGACY_STORAGE_KEY, loadArticles, STORAGE_KEY } from "@/lib/content";
import { PageHeading } from "./shell";
import { useIntegrations } from "./integrations";
import { ConfirmDialog } from "./dialog";
export function Settings() {
  const { articles, clear, mode, email, importLocal } = useWorkspace();
  const [localCount, setLocalCount] = useState(0);
  useEffect(() => {
    if (mode !== "account") return;
    try {
      setLocalCount(
        loadArticles(
          localStorage.getItem(STORAGE_KEY),
          localStorage.getItem(LEGACY_STORAGE_KEY),
        ).length,
      );
    } catch {
      setLocalCount(0);
    }
  }, [mode]);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const integrations = useIntegrations();
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
          <dd>
            {mode === "account"
              ? `계정 ${email ?? ""} · 데이터베이스에 저장`
              : "로컬 · 이 브라우저에서만 저장"}
          </dd>
          <dt>콘텐츠</dt>
          <dd>{articles.length}개</dd>
          <dt>글쓰기 템플릿</dt>
          <dd>10종 · 콘텐츠 작성 화면에서 선택</dd>
          <dt>AI 초안</dt>
          <dd>
            {!integrations
              ? "확인 중…"
              : integrations.ai.configured
                ? `연결됨 · 모델 ${integrations.ai.model}`
                : "미연결 · OPENAI_API_KEY 필요"}
          </dd>
          <dt>WordPress</dt>
          <dd>
            {!integrations
              ? "확인 중…"
              : integrations.wordpress.configured
                ? `설정됨 · ${integrations.wordpress.host} · 초안만 생성`
                : "미연결 · WP_BASE_URL/WP_USERNAME/WP_APP_PASSWORD 필요"}
          </dd>
          <dt>Supabase</dt>
          <dd>
            {!integrations
              ? "확인 중…"
              : { not_configured: "미설정", reachable: mode === "account" ? "연결됨 · 로그인·콘텐츠 저장에 사용 중" : "서버 응답 확인", unreachable: "설정됨 · 응답 없음" }[
                  integrations.supabase.status
                ]}
          </dd>
          <dt>로그인</dt>
          <dd>
            {mode === "account"
              ? `로그인됨 · ${email ?? ""}`
              : "미설정 · SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY 필요"}
          </dd>
          <dt>광고 API</dt>
          <dd>미연결</dd>
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
                const raw =
                  mode === "account"
                    ? JSON.stringify(articles, null, 2)
                    : (localStorage.getItem(STORAGE_KEY) ??
                      localStorage.getItem(LEGACY_STORAGE_KEY) ??
                      "[]");
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
          {mode !== "account" && (
            <button className="button danger" onClick={() => setConfirm(true)}>
              <Trash2 size={15} />
              로컬 데이터 초기화
            </button>
          )}
          {mode === "account" && localCount > 0 && (
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  const r = await importLocal();
                  setMessage(
                    `이 브라우저의 콘텐츠 ${r.imported}개를 계정으로 가져왔어요(건너뜀 ${r.skipped}, 형식 오류 ${r.invalid}, 실패 ${r.failed}). 검수·승인 상태는 승인 기록이 없어 초안 작성으로 가져왔으니 다시 승인해주세요.`,
                  );
                } catch (e) {
                  setMessage(e instanceof Error ? e.message : "가져오지 못했습니다.");
                }
              }}
            >
              브라우저 콘텐츠 {localCount}개 가져오기
            </button>
          )}
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
          템플릿 선택·원고 작성·AI 초안(키 설정 시)·수동 검수·HTML 내보내기·
          WordPress 초안 전송(설정 시)을 제공합니다. Supabase를 설정하면 로그인과
          데이터베이스 저장을 쓰고, 설정하지 않으면 이 브라우저에만 저장합니다.
          광고 데이터 수집과 팀 초대는 후속 단계입니다. 연동 키는 서버 환경 변수로만
          설정하며 브라우저에 저장되지 않습니다.
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
