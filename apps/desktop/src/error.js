// Fixed message table: the query string only selects a key, never injected as HTML.
const MESSAGES = {
  port_in_use: [
    "포트 34110을 다른 프로그램이 사용 중입니다.",
    "저장된 데이터 위치가 포트에 묶여 있어 다른 포트로 바꾸지 않습니다. 해당 프로그램을 종료한 뒤 다시 시도하세요.",
  ],
  missing_runtime: [
    "앱 구성 파일(Node 런타임 또는 웹 서버)을 찾지 못했습니다.",
    "설치가 손상되었을 수 있습니다. 앱을 다시 설치하세요.",
  ],
  start_failed: ["내장 서버를 실행하지 못했습니다.", "백신·보안 프로그램이 차단했는지 확인하세요."],
  health_timeout: ["내장 서버가 제시간에 준비되지 않았습니다.", "잠시 후 다시 시도하세요."],
  exited: ["내장 서버가 예기치 않게 종료되었습니다.", "다시 시도하면 서버를 새로 시작합니다."],
  job_failed: ["프로세스 보호 설정(Job Object)을 만들지 못했습니다.", "보안 프로그램을 확인한 뒤 다시 시도하세요."],
  config: ["설정 파일(desktop.env)을 읽지 못했습니다.", "%APPDATA%\\ContentFlow\\desktop.env 파일을 확인하세요."],
};

const code = new URLSearchParams(location.search).get("code");
const entry = MESSAGES[code] || ["알 수 없는 오류입니다.", ""];
document.getElementById("message").textContent = entry[0];
document.getElementById("hint").textContent = entry[1];

// withGlobalTauri is off; the bundled page uses the internal bridge directly.
const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
document.getElementById("retry").addEventListener("click", () => invoke && invoke("retry"));
document.getElementById("quit").addEventListener("click", () => invoke && invoke("quit_app"));
