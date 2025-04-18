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

////////////////////////////////////////////////////////////////////////////////////////////////////

pub struct EphemeralServer {
    core_runtime: Arc<CoreRuntime>,
    core_server: CoreEphemeralServer,
}

impl Finalize for EphemeralServer {}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("startEphemeralServer", start_ephemeral_server)?;
    cx.export_function("getEphemeralServerTarget", get_ephemeral_server_target)?;
    cx.export_function("shutdownEphemeralServer", shutdown_ephemeral_server)?;

    Ok(())
}

/// start an ephemeral temporal server
#[js_function]
pub fn start_ephemeral_server(
    runtime: OpaqueInboundHandle<Runtime>,
    config: config::EphemeralServerConfig,
) -> BridgeResult<BridgeFuture<OpaqueOutboundHandle<EphemeralServer>>> {
    let runtime = runtime.borrow_inner()?.core_runtime.clone();
    let config: CoreEphemeralServerConfig = config.try_into()?;

    runtime.clone().future_to_promise(async move {
        // Node intentionally drops stdout/stderr on process fork for security reasons,
        // which is causing various issues with ephemeral servers. To work around that
        // behavior, we explicitly force stdout/stderr on the child process.
        let stdout = Stdio::from(std::io::stdout());
        let stderr = Stdio::from(std::io::stderr());

        let core_server = config
            .start_server(stdout, stderr)
            .await
            .context("Failed to start ephemeral server")?;

        Ok(OpaqueOutboundHandle::new(EphemeralServer {
            core_runtime: runtime,
            core_server,
        }))
    })
}

/// get the ephemeral server "target" (address:port string)
#[js_function]
pub fn get_ephemeral_server_target(
    server: OpaqueInboundHandle<EphemeralServer>,
) -> BridgeResult<String> {
    Ok(server.borrow_inner()?.core_server.target.clone())
}

/// shutdown an ephemeral server - consumes the server
#[js_function]
pub fn shutdown_ephemeral_server(
    server: OpaqueInboundHandle<EphemeralServer>,
) -> BridgeResult<BridgeFuture<()>> {
    let mut server = server.take_inner()?;
    let runtime = server.core_runtime;

    runtime.future_to_promise(async move {
        server
            .core_server
            .shutdown()
            .await
            .context("Failed to shutdown ephemeral server")?;
        Ok(())
    })
}

////////////////////////////////////////////////////////////////////////////////////////////////////

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

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct TimeSkippingServerConfig {
        executable: EphemeralServerExecutableConfig,
        port: Option<u16>,
        extra_args: Vec<String>,
    }

    impl TryInto<CoreTestServerConfig> for TimeSkippingServerConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<CoreTestServerConfig, Self::Error> {
            let mut config = TestServerConfigBuilder::default();
            let config = config
                .exe(self.executable.try_into()?)
                .port(self.port)
                .extra_args(self.extra_args)
                .build()
                .context("Bulding Test Server config")?;

            Ok(config)
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct DevServerConfig {
        executable: EphemeralServerExecutableConfig,
        ip: String,
        port: Option<u16>,
        ui: bool,
        ui_port: Option<u16>,
        namespace: String,
        db_filename: Option<String>,
        log: DevServerLogConfig,
        extra_args: Vec<String>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct DevServerLogConfig {
        format: String,
        level: String,
    }

    impl TryInto<CoreTemporalDevServerConfig> for DevServerConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<CoreTemporalDevServerConfig, Self::Error> {
            let mut config = TemporalDevServerConfigBuilder::default();
            let config = config
                .exe(self.executable.try_into()?)
                .ip(self.ip)
                .port(self.port)
                .ui(self.ui)
                .ui_port(self.ui_port)
                .namespace(self.namespace)
                .db_filename(self.db_filename)
                .log((self.log.format, self.log.level))
                .extra_args(self.extra_args)
                .build()
                .context("Bulding Dev Server config")?;

            Ok(config)
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    enum EphemeralServerExecutableConfig {
        CachedDownload(CachedDownloadExecutable),
        ExistingPath(ExistingPathExecutable),
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct CachedDownloadExecutable {
        download_dir: Option<String>,
        version: String,
        ttl: Duration,
        sdk_version: String,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct ExistingPathExecutable {
        path: String,
    }

    impl TryInto<EphemeralExe> for EphemeralServerExecutableConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<EphemeralExe, Self::Error> {
            match self {
                Self::CachedDownload(config) => Ok(EphemeralExe::CachedDownload {
                    version: match config.version.as_str() {
                        "default" => EphemeralExeVersion::SDKDefault {
                            sdk_name: "sdk-typescript".to_owned(),
                            sdk_version: config.sdk_version,
                        },
                        _ => EphemeralExeVersion::Fixed(config.version),
                    },
                    dest_dir: config.download_dir,
                    ttl: Some(config.ttl),
                }),
                Self::ExistingPath(config) => Ok(EphemeralExe::ExistingPath(config.path)),
            }
        }
    }
}
