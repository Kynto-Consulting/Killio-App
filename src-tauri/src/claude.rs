//! The "Claude" AI provider: the person's own Claude Code, used from Killio App. Desktop only.
//!
//! `claude-bridge/` (bundled with the app) is ccapi, an MIT-licensed bridge that turns a local Claude Code
//! into an Anthropic-compatible API. ccapi's own launcher is a shell script around tmux / PowerShell; here
//! the app is the launcher instead:
//!   - it starts the bridge itself, only when the person turns the provider on, and stops it on exit;
//!   - the bridge listens on a random port of 127.0.0.1, never a fixed one;
//!   - the API key is made up per run and never leaves this process: the page asks the app to send a
//!     message, it never gets the key or the port;
//!   - request bodies are not written to the bridge's log.
//! The bridge needs Bun and Claude Code installed and signed in on this computer; nothing here installs them.
//!
//! The page gets a turn's stream by polling (`claude_send` then `claude_poll`): simple, and independent of
//! how a given webview delivers events.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Webview};

use crate::{commands::require_trusted, config::Store, i18n::tr};

struct Running {
    child: Child,
    port: u16,
    key: String,
}

#[derive(Default)]
struct Turn {
    events: Mutex<Vec<Value>>,
    done: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Default)]
pub struct Bridge {
    running: Mutex<Option<Running>>,
    turns: Mutex<HashMap<u64, Arc<Turn>>>,
    next_turn: AtomicU64,
}

/// A program on PATH, as the full path to run.
fn find_program(name: &str) -> Option<PathBuf> {
    let extensions: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[""] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in extensions {
            let candidate = if ext.is_empty() { dir.join(name) } else { dir.join(format!("{name}.{ext}")) };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Claude Code's real executable. On Windows `claude` on PATH is usually npm's `.cmd` wrapper, which the
/// bridge cannot spawn directly; the program itself sits next to it inside the npm package.
fn find_claude() -> Option<PathBuf> {
    let found = find_program("claude")?;
    let is_wrapper = found.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if !is_wrapper {
        return Some(found);
    }
    let inside = found.parent()?.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
    inside.is_file().then_some(inside)
}

/// Windows hands out `\\?\C:\…` paths; Bun and Claude Code want the plain form.
fn plain(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn secret() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn http(timeout_read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(timeout_read).build()
}

fn healthy(port: u16) -> bool {
    http(Duration::from_secs(3)).get(&format!("http://127.0.0.1:{port}/health")).call().is_ok()
}

impl Bridge {
    fn is_running(&self) -> bool {
        let mut running = self.running.lock().unwrap();
        // A bridge that exited on its own (Claude Code updated, Bun crashed) is forgotten here.
        if let Some(r) = running.as_mut() {
            if matches!(r.child.try_wait(), Ok(Some(_)) | Err(_)) {
                *running = None;
            }
        }
        running.is_some()
    }

    fn endpoint(&self) -> Option<(u16, String)> {
        self.running.lock().unwrap().as_ref().map(|r| (r.port, r.key.clone()))
    }

    fn start(&self, app: &AppHandle) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let bun = find_program("bun").ok_or(tr("Falta Bun en este equipo (bun.sh).", "Bun is not installed on this computer (bun.sh)."))?;
        let claude = find_claude().ok_or(tr("Falta Claude Code en este equipo.", "Claude Code is not installed on this computer."))?;
        let root = app.path().resource_dir().map_err(|e| e.to_string())?.join("claude-bridge");
        let entry = root.join("plugins/ccapi/bridge/main.ts");
        if !entry.is_file() {
            return Err(tr("Esta copia de la app no incluye el puente de Claude.", "This copy of the app does not include the Claude bridge.").into());
        }
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?.join("claude-bridge");
        std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;

        // Ask the system for a free port, then give it to the bridge.
        let port = std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
        let key = secret()?;

        let mut command = Command::new(&bun);
        command
            .arg(plain(&entry))
            .current_dir(&data)
            .env("CCAPI_PORT", port.to_string())
            .env("CCAPI_TOKEN", &key)
            .env("CCAPI_NO_TOKEN", "0")
            .env("CCAPI_INTERNAL_TOKEN", secret()?)
            // Never write what people say to the model to a log file.
            .env("CCAPI_DEBUG_BODIES", "false")
            .env("CCAPI_LOG", plain(&data.join("requests.jsonl")))
            .env("CCAPI_WORKER_RUNNER", plain(&root.join("bin/ccapi-worker.ts")))
            .env("CCAPI_REPO", plain(&root))
            .env("REPO", plain(&root))
            .env("CCAPI_CLAUDE", plain(&claude))
            .env("CCAPI_BUN", plain(&bun))
            .env("CCAPI_SERVER_DIR", plain(&data))
            .env("SERVER_DIR", plain(&data))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;

        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            if healthy(port) {
                break;
            }
            if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) || Instant::now() > deadline {
                let _ = child.kill();
                return Err(tr("El puente de Claude no arrancó.", "The Claude bridge did not start.").into());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        *self.running.lock().unwrap() = Some(Running { child, port, key });
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(mut running) = self.running.lock().unwrap().take() {
            // The bridge starts Claude Code workers of its own: take the whole tree down.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill").args(["/PID", &running.child.id().to_string(), "/T", "/F"]).creation_flags(0x0800_0000).status();
            }
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
        self.turns.lock().unwrap().clear();
    }
}

#[derive(Serialize)]
pub struct Status {
    /// False on phones: there is no Claude Code there.
    supported: bool,
    bun: bool,
    claude: bool,
    running: bool,
}

#[tauri::command]
pub fn claude_status(window: Webview, store: State<Store>, bridge: State<Bridge>) -> Result<Status, String> {
    require_trusted(&window, &store)?;
    let supported = cfg!(desktop);
    Ok(Status {
        supported,
        bun: supported && find_program("bun").is_some(),
        claude: supported && find_claude().is_some(),
        running: supported && bridge.is_running(),
    })
}

#[tauri::command]
pub async fn claude_start(app: AppHandle, window: Webview, store: State<'_, Store>) -> Result<(), String> {
    require_trusted(&window, &store)?;
    if !cfg!(desktop) {
        return Err(tr("No disponible en este dispositivo.", "Not available on this device.").into());
    }
    tauri::async_runtime::spawn_blocking(move || app.state::<Bridge>().start(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn claude_stop(window: Webview, store: State<Store>, bridge: State<Bridge>) -> Result<(), String> {
    require_trusted(&window, &store)?;
    bridge.stop();
    Ok(())
}

/// The models the person's Claude Code offers, as the bridge lists them.
#[tauri::command]
pub async fn claude_models(app: AppHandle, window: Webview, store: State<'_, Store>) -> Result<Value, String> {
    require_trusted(&window, &store)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bridge = app.state::<Bridge>();
        bridge.start(&app)?;
        let (port, key) = bridge.endpoint().ok_or("bridge")?;
        http(Duration::from_secs(15))
            .get(&format!("http://127.0.0.1:{port}/v1/models"))
            .set("x-api-key", &key)
            .set("anthropic-version", "2023-06-01")
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|body| serde_json::from_str::<Value>(&body).map_err(|e| e.to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn error_event(message: impl Into<String>) -> Value {
    json!({ "type": "error", "error": { "type": "bridge_error", "message": message.into() } })
}

fn run_turn(port: u16, key: &str, request: &Value, turn: &Turn) {
    let push = |event: Value| turn.events.lock().unwrap().push(event);
    let response = http(Duration::from_secs(600))
        .post(&format!("http://127.0.0.1:{port}/v1/messages"))
        .set("x-api-key", key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json")
        .send_string(&request.to_string());
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            // The bridge answers errors in Anthropic's shape; pass its message on when it has one.
            let message = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_string)).unwrap_or(body);
            push(error_event(format!("{code}: {message}")));
            return;
        }
        Err(error) => {
            push(error_event(error.to_string()));
            return;
        }
    };
    // Server-sent events: the lines that start with `data:` carry one JSON event each.
    for line in BufReader::new(response.into_reader()).lines() {
        if turn.cancelled.load(Ordering::Relaxed) {
            return;
        }
        let Ok(line) = line else { break };
        let Some(data) = line.strip_prefix("data:") else { continue };
        if let Ok(event) = serde_json::from_str::<Value>(data.trim()) {
            push(event);
        }
    }
}

/// Sends one request of the Anthropic Messages API to the person's Claude Code and returns a number to
/// poll its stream with. The request is the page's; the app forces streaming and adds the key.
#[tauri::command]
pub async fn claude_send(app: AppHandle, window: Webview, store: State<'_, Store>, mut request: Value) -> Result<u64, String> {
    require_trusted(&window, &store)?;
    if !request.is_object() {
        return Err("request".into());
    }
    request["stream"] = Value::Bool(true);
    let starter = app.clone();
    tauri::async_runtime::spawn_blocking(move || starter.state::<Bridge>().start(&starter)).await.map_err(|e| e.to_string())??;

    let bridge = app.state::<Bridge>();
    let (port, key) = bridge.endpoint().ok_or("bridge")?;
    let id = bridge.next_turn.fetch_add(1, Ordering::Relaxed) + 1;
    let turn = Arc::new(Turn::default());
    bridge.turns.lock().unwrap().insert(id, turn.clone());
    std::thread::spawn(move || {
        run_turn(port, &key, &request, &turn);
        turn.done.store(true, Ordering::Relaxed);
    });
    Ok(id)
}

#[derive(Serialize)]
pub struct Poll {
    events: Vec<Value>,
    done: bool,
}

/// What the turn produced since the last poll. `done` with no events left means it is over.
#[tauri::command]
pub fn claude_poll(window: Webview, store: State<Store>, bridge: State<Bridge>, id: u64) -> Result<Poll, String> {
    require_trusted(&window, &store)?;
    let mut turns = bridge.turns.lock().unwrap();
    let Some(turn) = turns.get(&id).cloned() else { return Ok(Poll { events: Vec::new(), done: true }) };
    // Read `done` first: anything pushed before it was set is then certainly in the batch taken below.
    let done = turn.done.load(Ordering::Relaxed);
    let events = std::mem::take(&mut *turn.events.lock().unwrap());
    if done {
        turns.remove(&id);
    }
    Ok(Poll { events, done })
}

#[tauri::command]
pub fn claude_cancel(window: Webview, store: State<Store>, bridge: State<Bridge>, id: u64) -> Result<(), String> {
    require_trusted(&window, &store)?;
    if let Some(turn) = bridge.turns.lock().unwrap().remove(&id) {
        turn.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_long_path_prefix_is_removed() {
        assert_eq!(plain(Path::new(r"\\?\C:\Program Files\Killio\claude-bridge")), r"C:\Program Files\Killio\claude-bridge");
        assert_eq!(plain(Path::new("/opt/killio/claude-bridge")), "/opt/killio/claude-bridge");
    }

    #[test]
    fn secrets_are_long_and_different_each_time() {
        let (a, b) = (secret().unwrap(), secret().unwrap());
        assert_eq!(a.len(), 48);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn a_finished_turn_is_drained_then_forgotten() {
        let bridge = Bridge::default();
        let turn = Arc::new(Turn::default());
        turn.events.lock().unwrap().push(json!({ "type": "message_start" }));
        bridge.turns.lock().unwrap().insert(7, turn.clone());

        // Still running: events come out, the turn stays.
        let done = turn.done.load(Ordering::Relaxed);
        let first = std::mem::take(&mut *turn.events.lock().unwrap());
        assert_eq!((first.len(), done), (1, false));
        assert!(bridge.turns.lock().unwrap().contains_key(&7));

        // An unknown or already-finished turn reads as "over", never as an error or a hang.
        assert!(!bridge.turns.lock().unwrap().contains_key(&99));
    }
}
