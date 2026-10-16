//! Desktop Node process and private loopback transport. Configuration is opt-in;
//! a crashed process is never silently restarted or given a new data directory.
use async_trait::async_trait;
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};
use tt_contracts::node_plugins::{PluginHostStatus, PluginRequest, PluginResponse};
use tt_domain::errors::DomainError;
use tt_ports::node_plugins::NodePluginRuntime;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    node: PathBuf,
    runtime: PathBuf,
}
#[derive(Deserialize)]
struct Ready {
    port: u16,
    plugins: Vec<String>,
}
struct Running {
    child: Child,
    // Keep the parent-liveness pipe open until graceful shutdown.
    _stdin: ChildStdin,
    port: u16,
    token: String,
    plugins: Vec<String>,
}
enum State {
    Idle,
    Running(Box<Running>),
    Stopped,
    Failed(String),
}

pub struct NodePluginProcess {
    data_root: PathBuf,
    supported: bool,
    client: reqwest::Client,
    state: Mutex<State>,
}

fn failure(error: impl std::fmt::Display) -> DomainError {
    DomainError::InternalError(format!("Node plugin host: {error}"))
}

impl NodePluginProcess {
    pub fn new(data_root: PathBuf, supported: bool) -> Result<Self, DomainError> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(failure)?;
        Ok(Self {
            data_root,
            supported,
            client,
            state: Mutex::new(State::Idle),
        })
    }

    async fn config(&self) -> Result<Option<Config>, DomainError> {
        let path = self.data_root.join("_tauritavern/node-plugins.json");
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(DomainError::file_io(
                    "read plugin configuration",
                    path.display().to_string(),
                    e,
                ));
            }
        };
        let config: Config = serde_json::from_slice(&bytes)
            .map_err(|e| DomainError::InvalidData(format!("{}: {e}", path.display())))?;
        if !config.node.is_absolute() || !config.runtime.is_absolute() {
            return Err(DomainError::InvalidData(
                "Node and runtime paths must be absolute".into(),
            ));
        }
        Ok(Some(config))
    }

    async fn spawn(&self, config: Config) -> Result<Running, DomainError> {
        let log_path = self.data_root.join("_tauritavern/node-plugins.log");
        let log = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .await
            .map_err(|e| {
                DomainError::file_io("open plugin log", log_path.display().to_string(), e)
            })?
            .into_std()
            .await;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut command = Command::new(&config.node);
        command
            .arg(config.runtime.join("host.mjs"))
            .current_dir(&config.runtime)
            // Node preload/loader options from the launching shell must not alter this runtime.
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command
            .spawn()
            .map_err(|e| failure(format!("launch {}: {e}", config.node.display())))?;
        let mut stdin = child.stdin.take().ok_or_else(|| failure("missing stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failure("missing stdout"))?;
        let config_line = serde_json::to_vec(&serde_json::json!({
            "token": token, "userRoot": self.data_root.join("default-user"),
        }))
        .map_err(failure)?;
        stdin.write_all(&config_line).await.map_err(failure)?;
        stdin.write_all(b"\n").await.map_err(failure)?;
        stdin.flush().await.map_err(failure)?;
        let mut stdout = BufReader::new(stdout);
        let mut line = String::new();
        // Bound the handshake independently of the 30-second endpoint timeout.
        use tokio::io::AsyncReadExt;
        tokio::time::timeout(
            Duration::from_secs(20),
            (&mut stdout).take(16 * 1024).read_line(&mut line),
        )
        .await
        .map_err(|_| failure("startup timed out; inspect _tauritavern/node-plugins.log"))?
        .map_err(failure)?;
        let ready: Ready = serde_json::from_str(&line).map_err(|e| {
            failure(format!(
                "invalid readiness message: {e}; inspect node-plugins.log"
            ))
        })?;
        if ready.port == 0 || ready.plugins.is_empty() {
            return Err(failure(
                "runtime loaded no plugins or returned an invalid port",
            ));
        }
        // Drain stdout even when a plugin bypasses console and writes directly.
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
        });
        Ok(Running {
            child,
            _stdin: stdin,
            port: ready.port,
            token,
            plugins: ready.plugins,
        })
    }

    fn inspect(state: &mut State) -> Result<(), DomainError> {
        if let State::Running(running) = state
            && let Some(code) = running.child.try_wait().map_err(failure)?
        {
            *state = State::Failed(format!(
                "process exited with {code}; inspect node-plugins.log"
            ));
        }
        Ok(())
    }

    fn snapshot(state: &State) -> PluginHostStatus {
        let (name, plugins, error) = match state {
            State::Idle => ("idle", vec![], None),
            State::Running(r) => ("running", r.plugins.clone(), None),
            State::Stopped => ("stopped", vec![], None),
            State::Failed(e) => ("failed", vec![], Some(e.clone())),
        };
        PluginHostStatus {
            state: name.into(),
            plugins,
            error,
        }
    }

    async fn ensure_started(&self, state: &mut State) -> Result<(), DomainError> {
        Self::inspect(state)?;
        match state {
            State::Running(_) => return Ok(()),
            State::Failed(e) => return Err(failure(e)),
            State::Stopped => {
                return Err(DomainError::Conflict(
                    "Node plugin host is stopped; start it explicitly".into(),
                ));
            }
            State::Idle => {}
        }
        if !self.supported {
            return Err(DomainError::InvalidData(
                "Node plugins require a desktop host".into(),
            ));
        }
        let config = self
            .config()
            .await?
            .ok_or_else(|| DomainError::NotFound("Node plugin host is not configured".into()))?;
        match self.spawn(config).await {
            Ok(running) => {
                *state = State::Running(Box::new(running));
                Ok(())
            }
            Err(error) => {
                *state = State::Failed(error.to_string());
                Err(error)
            }
        }
    }
}

#[async_trait]
impl NodePluginRuntime for NodePluginProcess {
    async fn status(&self) -> Result<PluginHostStatus, DomainError> {
        if !self.supported {
            return Ok(PluginHostStatus {
                state: "unsupported".into(),
                plugins: vec![],
                error: None,
            });
        }
        let mut state = self.state.lock().await;
        Self::inspect(&mut state)?;
        if matches!(*state, State::Idle) && self.config().await?.is_none() {
            return Ok(PluginHostStatus {
                state: "disabled".into(),
                plugins: vec![],
                error: None,
            });
        }
        Ok(Self::snapshot(&state))
    }

    async fn start(&self) -> Result<PluginHostStatus, DomainError> {
        let mut state = self.state.lock().await;
        Self::inspect(&mut state)?;
        if matches!(*state, State::Stopped | State::Failed(_)) {
            *state = State::Idle;
        }
        self.ensure_started(&mut state).await?;
        Ok(Self::snapshot(&state))
    }

    async fn stop(&self) -> Result<PluginHostStatus, DomainError> {
        let mut state = self.state.lock().await;
        if let State::Running(mut running) = std::mem::replace(&mut *state, State::Stopped)
            && running.child.try_wait().map_err(failure)?.is_none()
        {
            let response = self
                .client
                .post(format!("http://127.0.0.1:{}/_tt/shutdown", running.port))
                .header("x-tt-node-token", &running.token)
                .timeout(Duration::from_secs(2))
                .send()
                .await;
            if let Err(error) = response.and_then(reqwest::Response::error_for_status) {
                running.child.kill().await.map_err(failure)?;
                return Err(failure(format!(
                    "graceful shutdown failed; process killed: {error}"
                )));
            }
            if tokio::time::timeout(Duration::from_secs(3), running.child.wait())
                .await
                .map_err(failure)?
                .map_err(failure)?
                .success()
            {
                return Ok(Self::snapshot(&state));
            }
            return Err(failure("plugin exit hook failed; inspect node-plugins.log"));
        }
        Ok(Self::snapshot(&state))
    }

    async fn request(&self, request: PluginRequest) -> Result<PluginResponse, DomainError> {
        let (port, token) = {
            let mut state = self.state.lock().await;
            self.ensure_started(&mut state).await?;
            let State::Running(r) = &*state else {
                return Err(failure("host did not start"));
            };
            (r.port, r.token.clone())
        };
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(failure)?;
        let mut outgoing = self
            .client
            .request(method, format!("http://127.0.0.1:{port}{}", request.path))
            .header("x-tt-node-token", token);
        for (key, value) in request.headers {
            if ["content-type", "accept"].contains(&key.to_ascii_lowercase().as_str()) {
                outgoing = outgoing.header(key, value);
            }
        }
        let mut response = outgoing.body(request.body).send().await.map_err(failure)?;
        let status = response.status().as_u16();
        let mut headers = BTreeMap::new();
        for name in ["content-type", "cache-control", "content-disposition"] {
            if let Some(value) = response.headers().get(name) {
                headers.insert(name.into(), value.to_str().map_err(failure)?.into());
            }
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(failure)? {
            if body.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err(failure("plugin response exceeds 8 MiB"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(PluginResponse {
            status,
            headers,
            body,
        })
    }
}
