"use client";
import { useCallback, useEffect, useState } from "react";
import { loadChoice, saveChoice, type AiChoice } from "@/lib/ai-settings";
import { postJson } from "./integrations";
import { useFeedback } from "./feedback";

type ProviderInfo = { id: "gemini" | "openai"; label: string; configured: boolean; model: string; qaModel: string | null };
type Providers = { default: "gemini" | "openai" | null; providers: ProviderInfo[] };

/** AI API tab: which providers the server has keys for, and the provider/models this browser uses. */
export function AiApiPanel() {
  const [info, setInfo] = useState<Providers | null>(null);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<AiChoice>({});
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const { toast } = useFeedback();

  useEffect(() => {
    setChoice(loadChoice());
    let cancelled = false;
    fetch("/api/ai/providers", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as (Providers & { error?: string }) | null;
        if (!r.ok || !j) throw new Error(j?.error || "AI 설정을 불러오지 못했습니다.");
        if (!cancelled) setInfo(j);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "AI 설정을 불러오지 못했습니다."));
    return () => {
      cancelled = true;
    };
  }, []);

  const provider = info ? (choice.provider ?? info.default ?? "gemini") : "gemini";
  const current = info?.providers.find((p) => p.id === provider);
  const configured = !!current?.configured;

  const loadModels = useCallback(async () => {
    setModels([]);
    setModelsError("");
    try {
      const r = await postJson<{ models: string[] }>("/api/ai/models", { provider });
      setModels(r.models);
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : "모델 목록을 가져오지 못했습니다.");
    }
  }, [provider]);
  useEffect(() => {
    if (configured) void loadModels();
    else {
      setModels([]);
      setModelsError("");
    }
  }, [configured, loadModels]);

  function change(next: AiChoice) {
    setChoice(next);
    if (saveChoice(next)) {
      setMessage("");
      toast("이 브라우저에 저장했어요. 다음 AI 요청부터 적용됩니다.");
    } else setMessage("브라우저 저장소에 저장하지 못했습니다.");
  }
  async function test() {
    setTesting(true);
    setMessage("");
    try {
      const r = await postJson<{ count: number }>("/api/ai/test", { provider });
      toast(`연결됨 · 사용 가능한 모델 ${r.count}개`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "연결하지 못했습니다.");
    } finally {
      setTesting(false);
    }
  }
  const options = (selected: string | undefined, fallback: string | null) => {
    const list = selected && !models.includes(selected) ? [selected, ...models] : models;
    return [
      <option key="" value="">{`서버 기본값${fallback ? ` (${fallback})` : ""}`}</option>,
      ...list.map((m) => <option key={m} value={m}>{m}</option>),
    ];
  };

  if (error) return <p role="alert" className="metric-note">{error}</p>;
  if (!info) return <p className="metric-note">확인 중…</p>;
  return (
    <div className="settings-form">
      <dl className="detail-list">
        {info.providers.map((p) => (
          <div key={p.id} style={{ display: "contents" }}>
            <dt>{p.label}</dt>
            <dd>{p.configured ? "설정됨" : "미설정"}{info.default === p.id ? " · 기본" : ""}</dd>
          </div>
        ))}
      </dl>
      <div className="field">
        <label htmlFor="ai-provider">AI 제공자</label>
        <select
          id="ai-provider"
          value={provider}
          onChange={(e) => change({ provider: e.target.value as AiChoice["provider"] })}
        >
          {info.providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.configured}>
              {p.label}{p.configured ? "" : " (미설정)"}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ai-model">초안 모델</label>
        <select
          id="ai-model"
          disabled={!configured}
          value={choice.model ?? ""}
          onChange={(e) => change({ ...choice, provider, model: e.target.value || undefined })}
        >
          {options(choice.model, current?.model ?? null)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ai-qa-model">검수 모델</label>
        <select
          id="ai-qa-model"
          disabled={!configured}
          value={choice.qaModel ?? ""}
          onChange={(e) => change({ ...choice, provider, qaModel: e.target.value || undefined })}
        >
          {options(choice.qaModel, current?.qaModel ?? current?.model ?? null)}
        </select>
      </div>
      {modelsError && <p role="alert" className="metric-note">{modelsError}</p>}
      <div className="editor-actions">
        <button className="button secondary" disabled={!configured || testing} onClick={() => void test()}>
          {testing ? "확인 중…" : "연결 테스트"}
        </button>
      </div>
      {message && <p role="alert" className="metric-note">{message}</p>}
      <p>API 키는 서버 환경변수(GEMINI_API_KEY, OPENAI_API_KEY)에서만 설정합니다. 화면에서 입력하거나 저장하지 않으며, 이 화면에도 표시되지 않습니다.</p>
    </div>
  );
}
