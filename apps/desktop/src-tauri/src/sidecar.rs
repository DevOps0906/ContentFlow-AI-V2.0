//! Next.js standalone server as a child process: start, health check, stop.
//!
//! Contract with apps/web (proxy): DESKTOP_TOKEN (64 hex) / DESKTOP_PORT env,
//! `GET /api/health?nonce=` answers `{ok:true,hmac:HMAC-SHA256(token,nonce) hex}`,
//! `GET /desktop-auth?t=` sets the cf_desktop cookie. Child stdout/stderr are discarded
//! (the auth URL and env must never reach a log file).

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::fmt::Write as _;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Url};

use crate::os::{kill_if_image, Job};
use crate::PORT;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

/// Variables a desktop.env file may pass to the sidecar. Everything else is dropped.
const ENV_ALLOW: &[&str] = &[
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "APP_URL",
    "COOKIE_SECURE",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
];
const ENV_ALLOW_PREFIX: &[&str] = &["WP_"];
/// OS variables Node needs on Windows (env is otherwise cleared).
const ENV_OS: &[&str] = &["SystemRoot", "windir", "TEMP", "TMP"];

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    /// Bumped on every start/stop so stale threads stand down.
    generation: u64,
}

#[derive(Default, Clone)]
pub struct State {
    inner: Arc<Mutex<Inner>>,
    job: Arc<Mutex<Option<Arc<Job>>>>,
    /// Serialises whole start attempts so two runs never overlap.
    start_lock: Arc<Mutex<()>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn random_hex(n: usize) -> Result<String, &'static str> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|_| "start_failed")?;
    Ok(hex(&buf))
}

fn hmac_hex(token: &str, nonce: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("hmac accepts any key length");
    mac.update(nonce.as_bytes());
    hex(&mac.finalize().into_bytes())
}

fn clean_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn data_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(|p| PathBuf::from(p).join("ContentFlow"))
}

fn pid_file() -> Option<PathBuf> {
    data_dir("LOCALAPPDATA").map(|d| d.join("sidecar.pid"))
}

fn allowed(key: &str) -> bool {
    ENV_ALLOW.contains(&key) || ENV_ALLOW_PREFIX.iter().any(|p| key.starts_with(p))
}

/// Reads `%APPDATA%\ContentFlow\desktop.env` (KEY=VALUE lines). A missing file is fine.
fn load_desktop_env() -> Result<Vec<(String, String)>, &'static str> {
    let Some(path) = data_dir("APPDATA").map(|d| d.join("desktop.env")) else {
        return Ok(Vec::new());
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("config"),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim().trim_matches(|c| c == '"' || c == '\''));
        if allowed(k) && !v.is_empty() {
            out.push((k.to_string(), v.to_string()));
        }
    }
    Ok(out)
}

/// Kills a leftover sidecar from a crashed run, but only if the pid is still our node.exe.
fn cleanup_stale(node: &Path) {
    let Some(file) = pid_file() else { return };
    if let Ok(text) = std::fs::read_to_string(&file) {
        let mut lines = text.lines();
        let pid = lines.next().and_then(|l| l.trim().parse::<u32>().ok());
        let exe = lines.next().map(str::trim);
        if let (Some(pid), Some(exe)) = (pid, exe) {
            if Path::new(exe) == node {
                kill_if_image(pid, node);
            }
        }
    }
    let _ = std::fs::remove_file(file);
}

fn port_free() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    for _ in 0..10 {
        if TcpListener::bind(addr).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(300));
    }
    false
}

fn health_ok(token: &str, nonce: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(1)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!(
        "GET /api/health?nonce={nonce} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\n\r\n"
    );
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = s.take(64 * 1024).read_to_string(&mut body);
    body.starts_with("HTTP/1.1 200")
        && body.contains(&format!("\"hmac\":\"{}\"", hmac_hex(token, nonce)))
}

fn local_page(page: &str) -> Option<Url> {
    let base = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };
    Url::parse(&format!("{base}/{page}")).ok()
}

fn navigate(app: &AppHandle, url: Option<Url>) {
    if let (Some(w), Some(url)) = (app.get_webview_window("main"), url) {
        let _ = w.navigate(url);
    }
}

fn show_error(app: &AppHandle, code: &str) {
    navigate(app, local_page(&format!("error.html?code={code}")));
}

fn is_current(state: &State, generation: u64) -> bool {
    lock(&state.inner).generation == generation
}

fn spawn_sidecar(
    app: &AppHandle,
    state: &State,
    token: &str,
    generation: u64,
) -> Result<Child, &'static str> {
    let res = clean_path(app.path().resource_dir().map_err(|_| "missing_runtime")?).join("resources");
    let node = res.join("node").join("node.exe");
    let web = res.join("web").join("apps").join("web");
    let server = web.join("server.js");
    if !node.is_file() || !server.is_file() {
        return Err("missing_runtime");
    }

    let user_env = load_desktop_env()?;
    // Only the current generation may touch the pid file / kill stale processes.
    if !is_current(state, generation) {
        return Err("superseded");
    }
    cleanup_stale(&node);
    if !port_free() {
        return Err("port_in_use");
    }

    let mut cmd = Command::new(&node);
    cmd.arg(&server)
        .current_dir(&web)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in ENV_OS {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    let port = PORT.to_string();
    cmd.env("APP_URL", format!("http://127.0.0.1:{PORT}"))
        .env("COOKIE_SECURE", "false");
    cmd.envs(user_env);
    cmd.env("NODE_ENV", "production")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", &port)
        .env("DESKTOP_PORT", &port)
        .env("DESKTOP_TOKEN", token);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|_| "start_failed")?;
    let job = {
        let mut slot = lock(&state.job);
        if slot.is_none() {
            *slot = Job::new().map(Arc::new);
        }
        slot.clone()
    };
    // No Job Object means no kill-on-crash guarantee: refuse to run instead of continuing quietly.
    if !job.is_some_and(|j| j.assign(&child)) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("job_failed");
    }
    if let Some(file) = pid_file() {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, format!("{}\n{}\n", child.id(), node.display()));
    }
    Ok(child)
}

fn run(app: &AppHandle, state: &State, generation: u64) -> Result<(), &'static str> {
    let _serial = lock(&state.start_lock);
    if !is_current(state, generation) {
        return Err("superseded");
    }
    let token = random_hex(32)?; // 64 hex chars
    let mut child = spawn_sidecar(app, state, &token, generation)?;
    {
        let mut g = lock(&state.inner);
        if g.generation != generation {
            // A restart/stop happened while spawning: do not leave an orphan behind.
            let _ = child.kill();
            let _ = child.wait();
            return Err("superseded");
        }
        g.child = Some(child);
    }

    let started = Instant::now();
    loop {
        {
            let mut g = lock(&state.inner);
            if g.generation != generation {
                return Ok(()); // superseded by a restart or shutdown
            }
            if let Some(c) = g.child.as_mut() {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    return Err("start_failed");
                }
            }
        }
        let nonce = random_hex(16)?;
        if health_ok(&token, &nonce) {
            break;
        }
        if started.elapsed() > HEALTH_TIMEOUT {
            return Err("health_timeout");
        }
        thread::sleep(Duration::from_millis(300));
    }

    navigate(app, Url::parse(&format!("http://127.0.0.1:{PORT}/desktop-auth?t={token}")).ok());
    Ok(())
}

/// After the app is shown: a dead sidecar moves the window to the error page, no auto reload.
fn watch(app: AppHandle, state: State, generation: u64) {
    loop {
        thread::sleep(Duration::from_secs(1));
        let mut g = lock(&state.inner);
        if g.generation != generation {
            return;
        }
        let dead = match g.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
            None => true,
        };
        if dead {
            g.child = None;
            drop(g);
            show_error(&app, "exited");
            return;
        }
    }
}

fn kill_child(state: &State) {
    let child = {
        let mut g = lock(&state.inner);
        g.generation += 1;
        g.child.take()
    };
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    if let Some(file) = pid_file() {
        let _ = std::fs::remove_file(file);
    }
}

pub fn start(app: &AppHandle) {
    let state = app.state::<State>().inner().clone();
    let generation = {
        let mut g = lock(&state.inner);
        g.generation += 1;
        g.generation
    };
    let app = app.clone();
    thread::spawn(move || match run(&app, &state, generation) {
        Ok(()) => watch(app, state, generation),
        Err("superseded") => {}
        Err(code) => {
            if is_current(&state, generation) {
                kill_child(&state);
                show_error(&app, code);
            }
        }
    });
}

pub fn restart(app: &AppHandle) {
    let state = app.state::<State>().inner().clone();
    kill_child(&state);
    navigate(app, local_page("index.html"));
    start(app);
}

pub fn stop(app: &AppHandle) {
    kill_child(&app.state::<State>());
}
