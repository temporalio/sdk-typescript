use std::cell::RefCell;
use std::process::Stdio;
use std::sync::Arc;

use crate::conversions::*;
use crate::errors::*;
use crate::runtime::BoxedRuntimeRef;
use crate::runtime::RuntimeHandle;
use neon::prelude::*;
use temporal_sdk_core::ephemeral_server::EphemeralServer as CoreEphemeralServer;
use temporal_sdk_core::ephemeral_server::{
    TemporalDevServerConfig, TemporalDevServerConfigBuilder, TestServerConfig,
    TestServerConfigBuilder,
};

////////////////////////////////////////////////////////////////////////////////////////////////////

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on shutdown (requires mutability ^^^)
/// - Arc: So that we can safely pass the EphemeralServerHandle around -- FIXME: Is this useful?
/// - EphemeralServerHandle: The actual bridge ephemeral server handle (below)
pub type BoxedEphemeralServerRef = JsBox<RefCell<Option<EphemeralServerHandle>>>;

pub struct EphemeralServerHandle {
    pub(crate) runtime_handle: Arc<RuntimeHandle>, // FIXME: Should we inline rather than Arc?
    pub(crate) core_server: CoreEphemeralServer,
}

impl Finalize for EphemeralServerHandle {}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Start an ephemeral Temporal server
pub fn start_ephemeral_server(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let runtime = cx.argument::<BoxedRuntimeRef>(0)?;
    let runtime_ref = runtime.borrow();
    let runtime_handle = runtime_ref
        .as_ref()
        .expect("Tried to use Runtime after it has been shutdown")
        .clone();

    let server_options = cx
        .argument::<JsObject>(1)?
        .as_ephemeral_server_config(&mut cx)?;

    let (deferred, promise) = cx.promise();

    runtime_handle
        .core_runtime
        .tokio_handle()
        .spawn(async move {
            let stdout = Stdio::from(std::io::stdout());
            let stderr = Stdio::from(std::io::stderr());
            let result = match server_options {
                EphemeralServerConfig::TestServer(config) => {
                    config.start_server_with_output(stdout, stderr).await
                }
                EphemeralServerConfig::DevServer(config) => {
                    config.start_server_with_output(stdout, stderr).await
                }
            };

            let cx_channel = runtime_handle.cx_channel.clone();
            deferred
                .try_settle_with(cx_channel.as_ref(), move |mut cx: TaskContext| {
                    let runtime_handle = runtime_handle.clone();
                    match result {
                        Ok(server) => {
                            let server_handle = EphemeralServerHandle {
                                runtime_handle: runtime_handle.clone(),
                                core_server: server,
                            };
                            Ok(cx.boxed(RefCell::new(Some(server_handle))))
                        }
                        Err(err) => cx.throw_unexpected_error(format!(
                            "Failed to start ephemeral server: {}",
                            err
                        ))?,
                    }
                })
                .unwrap(); // Not much we can do at this point. It's time to panic.
        });

    Ok(promise)
}

/// Get the ephemeral server "target" (address:port string)
pub fn get_ephemeral_server_target(mut cx: FunctionContext) -> JsResult<JsString> {
    let server = cx.argument::<BoxedEphemeralServerRef>(0)?;
    let server_ref = server.borrow();
    let server_handle = server_ref
        .as_ref()
        .expect("Tried to use Ephemeral Server after it has been shutdown");

    Ok(cx.string(server_handle.core_server.target.as_str()))
}

/// Shutdown an ephemeral server - consumes the server
pub fn shutdown_ephemeral_server(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let server_ref = cx.argument::<BoxedEphemeralServerRef>(0)?;
    let server_handle = server_ref
        .take()
        .expect("Ephemeral Server has already been shutdown");

    let (deferred, promise) = cx.promise();

    let runtime_handle = server_handle.runtime_handle.clone();
    let mut core_server = server_handle.core_server;

    runtime_handle
        .core_runtime
        .tokio_handle()
        .spawn(async move {
            let result = core_server.shutdown().await;

            let cx_channel = runtime_handle.cx_channel.clone();
            deferred
                .try_settle_with(
                    cx_channel.as_ref(),
                    move |mut cx: TaskContext| match result {
                        Ok(_) => Ok(cx.undefined()),
                        Err(err) => cx.throw_unexpected_error(format!(
                            "Failed to shutdown ephemeral server: {}",
                            err
                        ))?,
                    },
                )
                .unwrap(); // Not much we can do at this point. It's time to panic.
        });

    Ok(promise)
}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub enum EphemeralServerConfig {
    TestServer(TestServerConfig),
    DevServer(TemporalDevServerConfig),
}

pub trait EphemeralServerConfigConversions {
    fn as_ephemeral_server_config(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<EphemeralServerConfig>;
}

impl EphemeralServerConfigConversions for Handle<'_, JsObject> {
    fn as_ephemeral_server_config(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<EphemeralServerConfig> {
        let sdk_version = js_value_getter!(cx, self, "sdkVersion", JsString);

        let js_executable = js_optional_getter!(cx, self, "executable", JsObject)
            .unwrap_or_else(|| cx.empty_object());
        js_executable.set_default(cx, "type", "cached-download")?;

        let exec_type = js_value_getter!(cx, &js_executable, "type", JsString);
        let executable = match exec_type.as_str() {
            "cached-download" => {
                let version = js_optional_value_getter!(cx, &js_executable, "version", JsString)
                    .unwrap_or_else(|| "default".to_owned());
                let dest_dir =
                    js_optional_value_getter!(cx, &js_executable, "downloadDir", JsString);

                let exec_version = match version.as_str() {
                    "default" => {
                        temporal_sdk_core::ephemeral_server::EphemeralExeVersion::SDKDefault {
                            sdk_name: "sdk-typescript".to_owned(),
                            sdk_version,
                        }
                    }
                    _ => temporal_sdk_core::ephemeral_server::EphemeralExeVersion::Fixed(version),
                };
                temporal_sdk_core::ephemeral_server::EphemeralExe::CachedDownload {
                    version: exec_version,
                    dest_dir,
                }
            }
            "existing-path" => {
                let path = js_value_getter!(cx, &js_executable, "path", JsString);
                temporal_sdk_core::ephemeral_server::EphemeralExe::ExistingPath(path)
            }
            _ => {
                return cx.throw_type_error(format!("Invalid executable type: {}", exec_type))?;
            }
        };
        let port = js_optional_getter!(cx, self, "port", JsNumber).map(|s| s.value(cx) as u16);

        let server_type = js_value_getter!(cx, self, "type", JsString);
        match server_type.as_str() {
            "dev-server" => {
                let mut config = TemporalDevServerConfigBuilder::default();
                config.exe(executable).port(port);

                if let Some(extra_args) = js_optional_getter!(cx, self, "extraArgs", JsArray) {
                    config.extra_args(extra_args.to_vec_of_string(cx)?);
                };
                if let Some(namespace) = js_optional_value_getter!(cx, self, "namespace", JsString)
                {
                    config.namespace(namespace);
                }
                if let Some(ip) = js_optional_value_getter!(cx, self, "ip", JsString) {
                    config.ip(ip);
                }
                config.db_filename(js_optional_value_getter!(cx, self, "dbFilename", JsString));
                config.ui(js_optional_value_getter!(cx, self, "ui", JsBoolean).unwrap_or_default());
                config.ui_port(
                    js_optional_getter!(cx, self, "uiPort", JsNumber).map(|s| s.value(cx) as u16),
                );
                if let Some(log) = js_optional_getter!(cx, self, "log", JsObject) {
                    let format = js_value_getter!(cx, &log, "format", JsString);
                    let level = js_value_getter!(cx, &log, "level", JsString);
                    config.log((format, level));
                }

                match config.build() {
                    Ok(config) => Ok(EphemeralServerConfig::DevServer(config)),
                    Err(err) => {
                        cx.throw_type_error(format!("Invalid dev server config: {:?}", err))
                    }
                }
            }
            "time-skipping" => {
                let mut config = TestServerConfigBuilder::default();
                config.exe(executable).port(port);

                if let Some(extra_args_js) = js_optional_getter!(cx, self, "extraArgs", JsArray) {
                    let extra_args = extra_args_js.to_vec_of_string(cx)?;
                    config.extra_args(extra_args);
                };

                match config.build() {
                    Ok(config) => Ok(EphemeralServerConfig::TestServer(config)),
                    Err(err) => {
                        cx.throw_type_error(format!("Invalid test server config: {:?}", err))
                    }
                }
            }
            s => cx.throw_type_error(format!(
                "Invalid ephemeral server type: {}, expected 'dev-server' or 'time-skipping'",
                s
            )),
        }
    }
}
