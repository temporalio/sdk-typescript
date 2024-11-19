use crate::{conversions::*, errors::*, helpers::*, worker::*};
use neon::{context::Context, prelude::*};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ops::Deref,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use temporal_client::{ClientInitError, ConfiguredClient, TemporalServiceClientWithMetrics};
use temporal_sdk_core::{
    api::telemetry::CoreTelemetry,
    ephemeral_server::EphemeralServer as CoreEphemeralServer,
    init_replay_worker, init_worker,
    replay::{HistoryForReplay, ReplayWorkerInput},
    ClientOptions, CoreRuntime, RetryClient, TokioRuntimeBuilder, WorkerConfig,
};
use tokio::sync::{
    mpsc::{channel, unbounded_channel, Sender, UnboundedReceiver, UnboundedSender},
    oneshot, Mutex,
};
use tokio_stream::wrappers::ReceiverStream;

pub type CoreClient = RetryClient<ConfiguredClient<TemporalServiceClientWithMetrics>>;

#[derive(Clone)]
pub struct EphemeralServer {
    pub(crate) runtime: Arc<RuntimeHandle>,
    pub(crate) core_server: Arc<Mutex<CoreEphemeralServer>>,
}
pub type BoxedEphemeralServer = JsBox<RefCell<Option<EphemeralServer>>>;
impl Finalize for EphemeralServer {}

pub struct RuntimeHandle {
    pub(crate) sender: UnboundedSender<RuntimeRequest>,
}

/// Box it so we can use the runtime from JS
pub type BoxedRuntime = JsBox<Arc<RuntimeHandle>>;
impl Finalize for RuntimeHandle {}

#[derive(Clone)]
pub struct Client {
    pub(crate) runtime: Arc<RuntimeHandle>,
    pub(crate) core_client: Arc<CoreClient>,
}

pub type BoxedClient = JsBox<RefCell<Option<Client>>>;
impl Finalize for Client {}

/// A request from JS to bridge to core
pub enum RuntimeRequest {
    /// A request to shutdown the runtime, breaks from the thread loop.
    Shutdown {
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to create a client in a runtime
    CreateClient {
        runtime: Arc<RuntimeHandle>,
        options: ClientOptions,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to update a client's HTTP request headers
    UpdateClientHeaders {
        client: Arc<CoreClient>,
        headers: HashMap<String, String>,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to create a new Worker using a connected client
    InitWorker {
        /// Worker configuration e.g. limits and task queue
        config: WorkerConfig,
        /// A client created with a [CreateClient] request
        client: Arc<CoreClient>,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to register a replay worker
    InitReplayWorker {
        runtime: Arc<RuntimeHandle>,
        /// Worker configuration. Must have unique task queue name.
        config: WorkerConfig,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to drain logs from core so they can be emitted in node
    PollLogs {
        /// Logs are sent to this function
        callback: Root<JsFunction>,
    },
    StartEphemeralServer {
        runtime: Arc<RuntimeHandle>,
        config: EphemeralServerConfig,
        callback: Root<JsFunction>,
    },
    ShutdownEphemeralServer {
        server: Arc<Mutex<CoreEphemeralServer>>,
        callback: Root<JsFunction>,
    },
    PushReplayHistory {
        tx: Sender<HistoryForReplay>,
        pushme: HistoryForReplay,
        callback: Root<JsFunction>,
    },
    UpdateClientApiKey {
        client: Arc<CoreClient>,
        key: String,
        callback: Root<JsFunction>,
    },
}

/// Builds a tokio runtime and starts polling on [RuntimeRequest]s via an internal channel.
/// Bridges requests from JS to core and sends responses back to JS using a neon::Channel.
/// Blocks current thread until a [Shutdown] request is received in channel.
pub fn start_bridge_loop(
    telemetry_options: TelemOptsRes,
    channel: Arc<Channel>,
    receiver: &mut UnboundedReceiver<RuntimeRequest>,
    result_sender: oneshot::Sender<Result<(), String>>,
) {
    let mut tokio_builder = tokio::runtime::Builder::new_multi_thread();
    tokio_builder.enable_all().thread_name("core");
    let telem_opts = telemetry_options.0;
    let meter_maker = telemetry_options.1;
    let tokio_builder: TokioRuntimeBuilder<Box<dyn Fn() + Send + Sync>> = TokioRuntimeBuilder {
        inner: tokio_builder,
        lang_on_thread_start: None,
    };
    let mut core_runtime =
        CoreRuntime::new(telem_opts, tokio_builder).expect("Failed to create CoreRuntime");

    core_runtime.tokio_handle().block_on(async {
        if let Some(meter_maker) = meter_maker {
            match meter_maker() {
                Ok(meter) => {
                    core_runtime.telemetry_mut().attach_late_init_metrics(meter);
                }
                Err(err) => {
                    result_sender
                        .send(Err(format!("Failed to create meter: {}", err)))
                        .unwrap_or_else(|_| {
                            panic!("Failed to report runtime start error: {}", err)
                        });
                    return;
                }
            }
        }
        result_sender
            .send(Ok(()))
            .expect("Failed to report runtime start success");

        loop {
            let request_option = receiver.recv().await;
            let request = match request_option {
                None => break,
                Some(request) => request,
            };

            let channel = channel.clone();

            match request {
                RuntimeRequest::Shutdown { callback } => {
                    send_result(channel, callback, |cx| Ok(cx.undefined()));
                    break;
                }
                RuntimeRequest::CreateClient {
                    runtime,
                    options,
                    callback,
                } => {
                    let mm = core_runtime.telemetry().get_temporal_metric_meter();
                    core_runtime.tokio_handle().spawn(async move {
                        match options
                            .connect_no_namespace(mm)
                            .await
                        {
                            Err(err) => {
                                send_error(channel.clone(), callback, |cx| match err {
                                    ClientInitError::SystemInfoCallError(e) => {
                                        make_named_error_from_string(
                                            cx,
                                            TRANSPORT_ERROR,
                                            format!("Failed to call GetSystemInfo: {}", e),
                                        )
                                    }
                                    ClientInitError::TonicTransportError(e) => {
                                        make_named_error_from_error(cx, TRANSPORT_ERROR, e)
                                    }
                                    ClientInitError::InvalidUri(e) => {
                                        Ok(JsError::type_error(cx, format!("{}", e))?)
                                    }
                                });
                            }
                            Ok(client) => {
                                send_result(channel.clone(), callback, |cx| {
                                    Ok(cx.boxed(RefCell::new(Some(Client {
                                        runtime,
                                        core_client: Arc::new(client),
                                    }))))
                                });
                            }
                        }
                    });
                }
                RuntimeRequest::UpdateClientHeaders {
                    client,
                    headers,
                    callback,
                } => {
                    client.get_client().set_headers(headers);
                    send_result(channel.clone(), callback, |cx| Ok(cx.undefined()));
                }
                RuntimeRequest::UpdateClientApiKey { client, key, callback } => {
                    client.get_client().set_api_key(Some(key));
                    send_result(channel.clone(), callback, |cx| Ok(cx.undefined()));
                }
                RuntimeRequest::PollLogs { callback } => {
                    let logs = core_runtime.telemetry().fetch_buffered_logs();
                    send_result(channel.clone(), callback, |cx| {
                        let logarr = cx.empty_array();
                        for (i, cl) in logs.into_iter().enumerate() {
                            // Not much to do here except for panic when there's an error here.
                            let logobj = cx.empty_object();

                            let level = cx.string(cl.level.to_string());
                            logobj.set(cx, "level", level).unwrap();

                            let ts = system_time_to_js(cx, cl.timestamp).unwrap();
                            logobj.set(cx, "timestamp", ts).unwrap();

                            let msg = cx.string(cl.message);
                            logobj.set(cx, "message", msg).unwrap();

                            let fieldsobj = hashmap_to_js_value(cx, cl.fields);
                            logobj.set(cx, "fields", fieldsobj.unwrap()).unwrap();

                            let target = cx.string(cl.target);
                            logobj.set(cx, "target", target).unwrap();

                            logarr.set(cx, i as u32, logobj).unwrap();
                        }
                        Ok(logarr)
                    });
                }
                RuntimeRequest::InitWorker {
                    config,
                    client,
                    callback,
                } => {
                    let client = (*client).clone();
                    match init_worker(&core_runtime, config, client) {
                        Ok(worker) => {
                            core_runtime.tokio_handle().spawn(start_worker_loop(
                                worker,
                                channel,
                                callback,
                                None,
                            ));
                        }
                        Err(err) => send_error(channel.clone(), callback, move |cx| {
                            make_named_error_from_error(cx, UNEXPECTED_ERROR, err.deref())
                        }),
                    }
                }
                RuntimeRequest::InitReplayWorker {
                    runtime,
                    config,
                    callback,
                } => {
                    let (tunnel, stream) = HistoryForReplayTunnel::new(runtime);
                    match init_replay_worker(ReplayWorkerInput::new(config, Box::pin(stream))) {
                        Ok(worker) => {
                            core_runtime.tokio_handle().spawn(start_worker_loop(
                                worker,
                                channel.clone(),
                                callback,
                                Some(tunnel),
                            ));
                        }
                        Err(err) => send_error(channel.clone(), callback, move |cx| {
                            make_named_error_from_error(cx, UNEXPECTED_ERROR, err.deref())
                        }),
                    };
                }
                RuntimeRequest::StartEphemeralServer {
                    runtime,
                    config,
                    callback,
                } => {
                    core_runtime.tokio_handle().spawn(async move {
                        let stdout = Stdio::from(std::io::stdout());
                        let stderr = Stdio::from(std::io::stderr());
                        let result = match config {
                            EphemeralServerConfig::TestServer(config) => {
                                config.start_server_with_output(stdout, stderr).await
                            }
                            EphemeralServerConfig::DevServer(config) => {
                                config.start_server_with_output(stdout, stderr).await
                            }
                        };
                        match result {
                            Err(err) => {
                                let err_str = format!("Failed to start ephemeral server: {}", err);
                                send_error(channel.clone(), callback, |cx| {
                                    make_named_error_from_string(cx, UNEXPECTED_ERROR, err_str)
                                });
                            }
                            Ok(server) => {
                                send_result(channel.clone(), callback, |cx| {
                                    Ok(cx.boxed(RefCell::new(Some(EphemeralServer {
                                        runtime,
                                        core_server: Arc::new(Mutex::new(server)),
                                    }))))
                                });
                            }
                        }
                    });
                }
                RuntimeRequest::ShutdownEphemeralServer { server, callback } => {
                    core_runtime.tokio_handle().spawn(async move {
                        void_future_to_js(
                            channel,
                            callback,
                            async move {
                                let mut guard = server.lock().await;
                                guard.shutdown().await
                            },
                            |cx, err| {
                                make_named_error_from_string(
                                    cx,
                                    UNEXPECTED_ERROR,
                                    format!("Failed to start test server: {}", err),
                                )
                            },
                        ).await
                    });
                }
                RuntimeRequest::PushReplayHistory {
                    tx,
                    pushme,
                    callback,
                } => {
                    core_runtime.tokio_handle().spawn(async move {
                        let sendfut = async move {
                            tx.send(pushme).await.map_err(|e| {
                                format!(
                                    "Receive side of history replay channel is gone. This is an sdk bug. {:?}",
                                    e
                                )
                            })
                        };
                        void_future_to_js(channel, callback, sendfut, |cx, err| {
                            make_named_error_from_string(
                                cx,
                                UNEXPECTED_ERROR,
                                format!("Error pushing replay history {}", err),
                            )
                        }).await
                    });
                }
            }
        }
    })
}

// Below are functions exported to JS

/// Convert Rust SystemTime into a JS array with 2 numbers (seconds, nanos)
pub fn system_time_to_js<'a, C>(cx: &mut C, time: SystemTime) -> NeonResult<Handle<'a, JsArray>>
where
    C: Context<'a>,
{
    let nanos = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    let only_nanos = cx.number((nanos % 1_000_000_000) as f64);
    let ts_seconds = cx.number((nanos / 1_000_000_000) as f64);
    let ts = cx.empty_array();
    ts.set(cx, 0, ts_seconds).unwrap();
    ts.set(cx, 1, only_nanos).unwrap();
    Ok(ts)
}

/// Helper to get the current time in nanosecond resolution.
pub fn get_time_of_day(mut cx: FunctionContext) -> JsResult<JsArray> {
    system_time_to_js(&mut cx, SystemTime::now())
}

/// Initialize Core global telemetry and create the tokio runtime required to run Core.
/// This should typically be called once on process startup.
/// Immediately spawns a poller thread that will block on [RuntimeRequest]s
pub fn runtime_new(mut cx: FunctionContext) -> JsResult<BoxedRuntime> {
    let telemetry_options = cx.argument::<JsObject>(0)?.as_telemetry_options(&mut cx)?;
    let channel = Arc::new(cx.channel());
    let (sender, mut receiver) = unbounded_channel::<RuntimeRequest>();

    // FIXME: This is a temporary fix to get sync notifications of errors while initializing the runtime.
    //        The proper fix would be to avoid spawning a new thread here, so that start_bridge_loop
    //        can simply yeild back a Result. But early attempts to do just that caused panics
    //        on runtime shutdown, so let's use this hack until we can dig deeper.
    let (result_sender, result_receiver) = oneshot::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        start_bridge_loop(telemetry_options, channel, &mut receiver, result_sender)
    });

    if let Ok(Err(e)) = result_receiver.blocking_recv() {
        Err(cx.throw_error::<_, String>(e).unwrap_err())?;
    }

    Ok(cx.boxed(Arc::new(RuntimeHandle { sender })))
}

/// Shutdown the Core instance and break out of the thread loop
pub fn runtime_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let request = RuntimeRequest::Shutdown {
        callback: callback.root(&mut cx),
    };
    if let Err(err) = runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };
    Ok(cx.undefined())
}

/// Request to drain forwarded logs from core
pub fn poll_logs(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let request = RuntimeRequest::PollLogs {
        callback: callback.root(&mut cx),
    };
    if let Err(err) = runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    }
    Ok(cx.undefined())
}

/// Create a connected gRPC client which can be used to initialize workers.
/// Client will be returned in the supplied `callback`.
pub fn client_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let opts = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let client_options = opts.as_client_options(&mut cx)?;

    let request = RuntimeRequest::CreateClient {
        runtime: (**runtime).clone(),
        options: client_options,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };

    Ok(cx.undefined())
}

/// Drop a reference to a Client, once all references are dropped, the Client will be closed.
pub fn client_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    if client.replace(None).is_none() {
        make_named_error_from_string(&mut cx, ILLEGAL_STATE_ERROR, "Client already closed")
            .and_then(|err| cx.throw(err))?;
    };
    Ok(cx.undefined())
}

/// Update a Client's HTTP request headers
pub fn client_update_headers(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let headers = cx
        .argument::<JsObject>(1)?
        .as_hash_map_of_string_to_string(&mut cx)?;
    let callback = cx.argument::<JsFunction>(2)?;

    match client.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Client")?;
        }
        Some(client) => {
            let request = RuntimeRequest::UpdateClientHeaders {
                client: client.core_client.clone(),
                headers,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = client.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
    }

    Ok(cx.undefined())
}

/// Update a Client's API key
pub fn client_update_api_key(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let key = cx.argument::<JsString>(1)?.value(&mut cx);
    let callback = cx.argument::<JsFunction>(2)?;

    match client.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Client")?;
        }
        Some(client) => {
            let request = RuntimeRequest::UpdateClientApiKey {
                client: client.core_client.clone(),
                key,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = client.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
    }

    Ok(cx.undefined())
}

pub(crate) struct HistoryForReplayTunnel {
    pub(crate) runtime: Arc<RuntimeHandle>,
    sender: Cell<Option<Sender<HistoryForReplay>>>,
}
impl HistoryForReplayTunnel {
    fn new(runtime: Arc<RuntimeHandle>) -> (Self, ReceiverStream<HistoryForReplay>) {
        let (sender, rx) = channel(1);
        (
            HistoryForReplayTunnel {
                runtime,
                sender: Cell::new(Some(sender)),
            },
            ReceiverStream::new(rx),
        )
    }
    pub fn get_chan(&self) -> Result<Sender<HistoryForReplay>, &'static str> {
        let chan = self.sender.take();
        self.sender.set(chan.clone());
        if let Some(chan) = chan {
            Ok(chan)
        } else {
            Err("History replay channel is already closed")
        }
    }
    pub fn shutdown(&self) {
        self.sender.take();
    }
}
impl Finalize for HistoryForReplayTunnel {}
