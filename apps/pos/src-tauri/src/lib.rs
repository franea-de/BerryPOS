use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent};

/// The spawned register server (Node); killed when the app exits.
struct ServerProcess(Mutex<Option<Child>>);

const SERVER_URL: &str = "http://127.0.0.1:1421";

/// Find the bundled server script walking up from the executable
/// (target/debug|release -> src-tauri -> apps/pos/dist-server).
fn server_script() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors() {
        let candidate = ancestor.join("dist-server").join("main.mjs");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Spawn the register server. If another instance already owns the port
/// (e.g. the dev server), the child exits on its own and the window simply
/// connects to the existing one.
fn spawn_server() -> Option<Child> {
    let script = server_script()?;
    let workdir = script.parent()?.parent()?.to_path_buf();
    let mut cmd = Command::new("node");
    cmd.arg(&script).current_dir(&workdir);

    // Load local environment variables from .env file next to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let env_file = dir.join(".env");
            if env_file.exists() {
                if let Ok(content) = std::fs::read_to_string(&env_file) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() || trimmed.starts_with('#') {
                            continue;
                        }
                        if let Some((key, val)) = trimmed.split_once('=') {
                            let clean_val = val.trim().trim_matches('"').trim_matches('\'');
                            cmd.env(key.trim(), clean_val);
                        }
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let child = spawn_server();
            app.manage(ServerProcess(Mutex::new(child)));

            // Show the window only when the server answers, so the cashier
            // never sees a connection error at boot.
            let window = app.get_webview_window("main");
            std::thread::spawn(move || {
                for _ in 0..40 {
                    if TcpStream::connect(("127.0.0.1", 1421)).is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                if let Some(w) = window {
                    let _ = w.eval(&format!("window.location.replace('{SERVER_URL}')"));
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building BerryPOS");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<ServerProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
