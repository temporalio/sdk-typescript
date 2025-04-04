use std::cell::RefCell;
use std::process::Stdio;
use std::sync::Arc;

use crate::future::*;
use crate::helpers::BridgeError;
use crate::helpers::BridgeResult;
use crate::helpers::CustomJavaScriptErrors;
use crate::helpers::IntoThrow;
use crate::helpers::TryFromJs;
use crate::helpers::TryIntoJs;
use crate::runtime::RuntimeHandle;
use anyhow::Context as _;
use bridge_macros::js_function;
use neon::prelude::*;
use temporal_sdk_core::ephemeral_server::EphemeralServer as CoreEphemeralServer;
use temporal_sdk_core::ephemeral_server::{
    TemporalDevServerConfig as CoreTemporalDevServerConfig,
    TestServerConfig as CoreTestServerConfig,
};

use config::*;

////////////////////////////////////////////////////////////////////////////////////////////////////

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on shutdown (requires mutability ^^^)
/// - EphemeralServerHandle: The actual bridge ephemeral server handle (below)
pub type BoxedEphemeralServerRef = JsBox<RefCell<Option<EphemeralServerHandle>>>;

#[derive(Clone)]
pub struct EphemeralServerHandle {
    pub(crate) runtime_handle: RuntimeHandle,
    core_server: Arc<CoreEphemeralServer>, // Arc because EphemeralServerHandle needs to be Clone
}

impl Finalize for EphemeralServerHandle {}

impl TryFromJs for EphemeralServerHandle {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let server = js_value.downcast::<BoxedEphemeralServerRef, _>(cx)?;
        let server = server.borrow();
        Ok(server
            .as_ref()
            .ok_or(BridgeError::IllegalStateAlreadyClosed {
                what: "EphemeralServer",
            })?
            .clone())
    }
}

impl TryIntoJs for EphemeralServerHandle {
    type Output = BoxedEphemeralServerRef;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, BoxedEphemeralServerRef> {
        Ok(cx.boxed(RefCell::new(Some(self.clone()))))
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// start an ephemeral temporal server
#[js_function]
pub fn start_ephemeral_server(
    runtime: RuntimeHandle,
    config: EphemeralServerConfig,
) -> BridgeResult<BridgeFuture<EphemeralServerHandle>> {
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

        Ok(EphemeralServerHandle {
            runtime_handle: runtime.clone(),
            core_server: Arc::new(core_server),
        })
    })
}

/// get the ephemeral server "target" (address:port string)
#[js_function]
pub fn get_ephemeral_server_target(server: EphemeralServerHandle) -> BridgeResult<String> {
    Ok(server.core_server.target.clone())
}

/// shutdown an ephemeral server - consumes the server
// FIXME: Make this a js_function ...
pub fn shutdown_ephemeral_server(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let server: Handle<BoxedEphemeralServerRef> = cx.argument(0)?;
    let mut server_ref = server.borrow_mut();
    let server_handle = server_ref
        .take()
        .ok_or(())
        .or_else(|_| cx.throw_illegal_state_error("ephemeral server has already been shutdown"))?;

    let mut core_server = Arc::try_unwrap(server_handle.core_server).or_else(|_| {
        cx.throw_illegal_state_error("Should be the last reference to the ephemeral server")
    })?;

    server_handle
        .runtime_handle
        .future_to_promise(async move {
            let res = core_server.shutdown().await;
            match res {
                Ok(()) => Ok(()),
                Err(err) => Err(BridgeError::Other(err)),
            }
        })
        .into_throw(&mut cx)?
        .try_into_js(&mut cx)
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
            CoreEphemeralServerConfig::TimeSkipping(config) => {
                config.start_server_with_output(stdout, stderr).await
            }
            CoreEphemeralServerConfig::DevServer(config) => {
                config.start_server_with_output(stdout, stderr).await
            }
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use anyhow::Context as _;
    use bridge_macros::TryFromJs;
    use std::time::Duration;

    use temporal_sdk_core::ephemeral_server::{
        EphemeralExe, EphemeralExeVersion, TemporalDevServerConfig as CoreTemporalDevServerConfig,
        TemporalDevServerConfigBuilder, TestServerConfig as CoreTestServerConfig,
        TestServerConfigBuilder,
    };

    use crate::helpers::BridgeError;

    use super::CoreEphemeralServerConfig;

    #[derive(Debug, Clone, TryFromJs)]
    pub enum EphemeralServerConfig {
        TimeSkipping(TimeSkippingServerConfig),
        DevServer(DevServerConfig),
    }

    impl TryInto<CoreEphemeralServerConfig> for EphemeralServerConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<CoreEphemeralServerConfig, Self::Error> {
            match self {
                EphemeralServerConfig::TimeSkipping(config) => {
                    Ok(CoreEphemeralServerConfig::TimeSkipping(config.try_into()?))
                }
                EphemeralServerConfig::DevServer(config) => {
                    Ok(CoreEphemeralServerConfig::DevServer(config.try_into()?))
                }
            }
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub struct TimeSkippingServerConfig {
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
    pub struct DevServerConfig {
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
    pub struct DevServerLogConfig {
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
                EphemeralServerExecutableConfig::CachedDownload(config) => {
                    Ok(EphemeralExe::CachedDownload {
                        version: match config.version.as_str() {
                            "default" => EphemeralExeVersion::SDKDefault {
                                sdk_name: "sdk-typescript".to_owned(),
                                sdk_version: config.sdk_version,
                            },
                            _ => EphemeralExeVersion::Fixed(config.version),
                        },
                        dest_dir: config.download_dir,
                        ttl: Some(config.ttl),
                    })
                }
                EphemeralServerExecutableConfig::ExistingPath(config) => {
                    Ok(EphemeralExe::ExistingPath(config.path))
                }
            }
        }
    }
}
