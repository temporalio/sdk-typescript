use std::io::{Read as _, Write as _};
use std::{process::Stdio, sync::Arc};

use anyhow::Context as _;
use neon::prelude::*;

use temporal_sdk_core::ephemeral_server::{
    EphemeralServer as CoreEphemeralServer, TemporalDevServerConfig as CoreTemporalDevServerConfig,
    TestServerConfig as CoreTestServerConfig,
};

use bridge_macros::js_function;
use temporal_sdk_core::CoreRuntime;

use crate::helpers::*;
use crate::runtime::{Runtime, RuntimeExt as _};

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("newEphemeralServer", ephemeral_server_new)?;
    cx.export_function("ephemeralServerGetTarget", ephemeral_server_get_target)?;
    cx.export_function("ephemeralServerShutdown", ephemeral_server_shutdown)?;

    Ok(())
}

pub struct EphemeralServer {
    core_runtime: Arc<CoreRuntime>,
    core_server: CoreEphemeralServer,
    stdout_thread: Option<std::thread::JoinHandle<()>>,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
}

/// Start an ephemeral Temporal server
#[js_function]
pub fn ephemeral_server_new(
    runtime: OpaqueInboundHandle<Runtime>,
    config: config::EphemeralServerConfig,
) -> BridgeResult<BridgeFuture<OpaqueOutboundHandle<EphemeralServer>>> {
    let runtime = runtime.borrow()?.core_runtime.clone();
    let config: CoreEphemeralServerConfig = config.try_into()?;

    runtime.clone().future_to_promise(async move {
        let (stdout, stderr, stdout_thread, stderr_thread) = get_stdout_stderr()?;

        let core_server = config
            .start_server(stdout, stderr)
            .await
            .context("Failed to start ephemeral server")?;

        Ok(OpaqueOutboundHandle::new(EphemeralServer {
            core_runtime: runtime,
            core_server,
            stdout_thread,
            stderr_thread,
        }))
    })
}

// Node intentionally drops stdout/stderr on process fork for security reasons, which
// is causing various issues with ephemeral servers. To work around that behavior, we
// explicitly force stdout/stderr on the child process. Unfortunately, simply propagating
// our stdout and stderr also cause issues, as some test engines (e.g. ava) run tests in
// worker threads or child processes, with pipes as stdout/stderr. When tests complete,
// the engine stops draining the pipe, preventing remaining ephemeral servers from exiting.
//
// Solution is to make our own pipes that forward the the ephemeral server's stdout/stderr
// to our own, with some simple logic to drop any output generated after the parent process
// has closed its handles to the pipes. For now, that logic is implemented using a thread
// per pipe. Replacing with async is definitely possible, but may require some work on the
// Core side. For now, we'll just live with the extra threads.
// FIXME: Investigate use of async io for stdout/stderr forwarding.
#[allow(clippy::type_complexity)] // Acceptable until this is revisited
fn get_stdout_stderr() -> BridgeResult<(
    Stdio,
    Stdio,
    Option<std::thread::JoinHandle<()>>,
    Option<std::thread::JoinHandle<()>>,
)> {
    let (mut stdout_read, stdout_write) = os_pipe::pipe().context("Failed to create pipe")?;
    let (mut stderr_read, stderr_write) = os_pipe::pipe().context("Failed to create pipe")?;

    let stdout = Stdio::from(stdout_write);
    let stderr = Stdio::from(stderr_write);

    // Start threads to forward the output
    let stdout_thread = std::thread::spawn(move || {
        let mut buffer = [0; 1024];
        loop {
            match stdout_read.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    std::io::stdout().write_all(&buffer[0..n]).ok();
                    std::io::stdout().flush().ok();
                }
            }
        }
    });

    let stderr_thread = std::thread::spawn(move || {
        let mut buffer = [0; 1024];
        loop {
            match stderr_read.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    std::io::stderr().write_all(&buffer[0..n]).ok();
                    std::io::stderr().flush().ok();
                }
            }
        }
    });

    Ok((stdout, stderr, Some(stdout_thread), Some(stderr_thread)))
}

/// Get the "target address" (address:port string) of a running ephemeral server.
#[js_function]
pub fn ephemeral_server_get_target(
    server: OpaqueInboundHandle<EphemeralServer>,
) -> BridgeResult<String> {
    Ok(server.borrow()?.core_server.target.clone())
}

/// Shutdown an ephemeral server.
#[js_function]
pub fn ephemeral_server_shutdown(
    server: OpaqueInboundHandle<EphemeralServer>,
) -> BridgeResult<BridgeFuture<()>> {
    let mut server = server.take()?;

    let runtime = server.core_runtime.clone();
    runtime.future_to_promise(async move {
        server
            .core_server
            .shutdown()
            .await
            .context("Failed to shutdown ephemeral server")?;

        let _ = server
            .stdout_thread
            .take()
            .map(std::thread::JoinHandle::join);

        let _ = server
            .stderr_thread
            .take()
            .map(std::thread::JoinHandle::join);

        Ok(())
    })
}

impl MutableFinalize for EphemeralServer {
    fn finalize_mut(mut self) {
        self.core_runtime.clone().tokio_handle().spawn(async move {
            // We can't really do anything about errors here, so we just ignore them
            let _ = self.core_server.shutdown().await;
            self.stdout_thread.take().map(std::thread::JoinHandle::join);
            self.stderr_thread.take().map(std::thread::JoinHandle::join);
        });
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

// Contrarily to other SDKs and to the APIs that Core SDK exposes, we use a common code path for
// both kind of ephemeral servers, so we need an extra abstraction layer to make both adhere
// to a common interface.  Hopefully, these should be defined in the core-bridge crate.

enum CoreEphemeralServerConfig {
    TimeSkipping(CoreTestServerConfig),
    DevServer(CoreTemporalDevServerConfig),
}

impl CoreEphemeralServerConfig {
    async fn start_server(
        self,
        stdout: Stdio,
        stderr: Stdio,
    ) -> anyhow::Result<CoreEphemeralServer> {
        match self {
            Self::TimeSkipping(config) => config.start_server_with_output(stdout, stderr).await,
            Self::DevServer(config) => config.start_server_with_output(stdout, stderr).await,
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use std::time::Duration;

    use anyhow::Context as _;

    use temporal_sdk_core::ephemeral_server::{
        EphemeralExe, EphemeralExeVersion, TemporalDevServerConfig as CoreTemporalDevServerConfig,
        TemporalDevServerConfigBuilder, TestServerConfig as CoreTestServerConfig,
        TestServerConfigBuilder,
    };

    use bridge_macros::TryFromJs;

    use crate::helpers::BridgeError;

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) enum EphemeralServerConfig {
        TimeSkipping(TimeSkippingServerConfig),
        DevServer(DevServerConfig),
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct TimeSkippingServerConfig {
        exe: EphemeralServerExecutableConfig,
        port: Option<u16>,
        extra_args: Vec<String>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct DevServerConfig {
        exe: EphemeralServerExecutableConfig,
        namespace: String,
        ip: String,
        port: Option<u16>,
        ui_port: Option<u16>,
        db_filename: Option<String>,
        ui: bool,
        log: DevServerLogConfig,
        extra_args: Vec<String>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct DevServerLogConfig {
        format: String,
        level: String,
    }

    #[derive(Debug, Clone, TryFromJs)]
    enum EphemeralServerExecutableConfig {
        CachedDownload(CachedDownloadConfig),
        ExistingPath(ExistingPathConfig),
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct CachedDownloadConfig {
        download_dir: Option<String>,
        version: String,
        ttl: Duration,
        sdk_name: String,
        sdk_version: String,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct ExistingPathConfig {
        path: String,
    }

    impl TryInto<super::CoreEphemeralServerConfig> for EphemeralServerConfig {
        type Error = BridgeError;
        fn try_into(self) -> Result<super::CoreEphemeralServerConfig, Self::Error> {
            match self {
                Self::TimeSkipping(config) => Ok(super::CoreEphemeralServerConfig::TimeSkipping(
                    config.try_into()?,
                )),
                Self::DevServer(config) => Ok(super::CoreEphemeralServerConfig::DevServer(
                    config.try_into()?,
                )),
            }
        }
    }

    impl TryInto<CoreTestServerConfig> for TimeSkippingServerConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<CoreTestServerConfig, Self::Error> {
            let mut config = TestServerConfigBuilder::default();
            let config = config
                .exe(self.exe.into())
                .port(self.port)
                .extra_args(self.extra_args)
                .build()
                .context("Invalid Test Server config")?;

            Ok(config)
        }
    }

    impl TryInto<CoreTemporalDevServerConfig> for DevServerConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<CoreTemporalDevServerConfig, Self::Error> {
            let mut config = TemporalDevServerConfigBuilder::default();
            let config = config
                .exe(self.exe.into())
                .namespace(self.namespace)
                .ip(self.ip)
                .port(self.port)
                .ui_port(self.ui_port)
                .db_filename(self.db_filename)
                .ui(self.ui)
                .log((self.log.format, self.log.level))
                .extra_args(self.extra_args)
                .build()
                .context("Invalid Dev Server config")?;

            Ok(config)
        }
    }

    impl From<EphemeralServerExecutableConfig> for EphemeralExe {
        fn from(val: EphemeralServerExecutableConfig) -> Self {
            match val {
                EphemeralServerExecutableConfig::CachedDownload(config) => Self::CachedDownload {
                    version: match config.version.as_str() {
                        "default" => EphemeralExeVersion::SDKDefault {
                            sdk_name: config.sdk_name,
                            sdk_version: config.sdk_version,
                        },
                        _ => EphemeralExeVersion::Fixed(config.version),
                    },
                    dest_dir: config.download_dir,
                    ttl: Some(config.ttl),
                },
                EphemeralServerExecutableConfig::ExistingPath(config) => {
                    Self::ExistingPath(config.path)
                }
            }
        }
    }
}
