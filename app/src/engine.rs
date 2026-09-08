use serde_json::{json, Value};
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicU64, Ordering}, mpsc, Arc, Mutex},
};

pub struct EngineBridge {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    events: Arc<Mutex<mpsc::Receiver<Value>>>,
    next_id: AtomicU64,
}

impl EngineBridge {
    pub fn spawn() -> Result<Self, String> {
        let path = engine_path();
        let mut child = Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("LINEY_LIGHT_START", "1")
            .spawn()
            .map_err(|error| format!("เปิด LINE engine ไม่ได้ ({}): {error}", path.display()))?;
        let stdin = child.stdin.take().ok_or("LINE engine ไม่มี stdin")?;
        let stdout = child.stdout.take().ok_or("LINE engine ไม่มี stdout")?;
        let stderr = child.stderr.take().ok_or("LINE engine ไม่มี stderr")?;
        let (sender, receiver) = mpsc::channel();

        let output_sender = sender.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let _ = output_sender.send(value);
                }
            }
            let _ = output_sender.send(json!({ "type": "engine.closed" }));
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("liney-engine: {line}");
            }
        });

        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            events: Arc::new(Mutex::new(receiver)),
            next_id: AtomicU64::new(1),
        })
    }

    pub fn request(&self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let line = serde_json::to_string(&json!({ "id": id, "version": 1, "method": method, "params": params }))
            .map_err(|error| error.to_string())?;
        let mut stdin = self.stdin.lock().map_err(|_| "LINE engine stdin ถูกล็อก")?;
        writeln!(stdin, "{line}").map_err(|error| format!("ส่งคำสั่งไป LINE engine ไม่ได้: {error}"))?;
        stdin.flush().map_err(|error| error.to_string())?;
        Ok(id)
    }

    pub fn drain(&self, max_events: usize) -> Vec<Value> {
        let Ok(receiver) = self.events.lock() else { return Vec::new() };
        let mut events = Vec::new();
        for _ in 0..max_events {
            match receiver.try_recv() {
                Ok(value) => events.push(value),
                Err(_) => break,
            }
        }
        events
    }

    pub fn terminate(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

impl Drop for EngineBridge {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub fn engine_path() -> PathBuf {
    if let Some(path) = env::var_os("LINEY_ENGINE_BINARY") {
        return PathBuf::from(path);
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            let bundled = parent.join("liney-engine");
            if bundled.is_file() { return bundled; }
        }
    }
    if let Some(path) = env::var_os("HOME").map(PathBuf::from).map(|p| p.join(".local/lib/liney/liney-engine")).filter(|p| p.is_file()) {
        return path;
    }
    let system = PathBuf::from("/usr/lib/liney/liney-engine");
    if system.is_file() { return system; }
    let host = env::var("HOST").unwrap_or_else(|_| "x86_64-unknown-linux-gnu".into());
    PathBuf::from(format!("build/liney-engine-{host}"))
}
