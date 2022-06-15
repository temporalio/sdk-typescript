mod conversions;
mod errors;

use crate::conversions::{get_optional, ObjectHandleConversionsExt};
use errors::*;
use futures::stream::StreamExt;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use opentelemetry::trace::{FutureExt, SpanContext, TraceContextExt};
use parking_lot::RwLock;
use prost::Message;
use std::collections::HashMap;
use std::{
    cell::RefCell,
    fmt::Display,
    future::Future,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use temporal_client::{
    AnyClient, ClientInitError, ConfiguredClient, WorkflowServiceClientWithMetrics,
};
use temporal_sdk_core::{
    api::{
        errors::{CompleteActivityError, CompleteWfError, PollActivityError, PollWfError},
        Worker as CoreWorkerTrait,
    },
    fetch_global_buffered_logs, init_replay_worker, init_worker,
    protos::{
        coresdk::{
            workflow_completion::WorkflowActivationCompletion, ActivityHeartbeat,
            ActivityTaskCompletion,
        },
        temporal::api::history::v1::History,
    },
    telemetry_init, ClientOptions, RetryClient, Worker as CoreWorker, WorkerConfig,
};
use tokio::{
    runtime::Runtime,
    sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
};
use tokio_stream::wrappers::UnboundedReceiverStream;

type RawClient = RetryClient<ConfiguredClient<WorkflowServiceClientWithMetrics>>;

/// A request from JS to bridge to core
enum RuntimeRequest {
    /// A request to shutdown the runtime, breaks from the thread loop.
    Shutdown {
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to create a client in a runtime
    CreateClient {
        runtime: Arc<RuntimeHandle>,
        options: ClientOptions,
        headers: Option<HashMap<String, String>>,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to update a client's HTTP request headers
    UpdateClientHeaders {
        client: Arc<RawClient>,
        headers: HashMap<String, String>,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to create a new Worker using a connected client
    InitWorker {
        /// Worker configuration e.g. limits and task queue
        config: WorkerConfig,
        /// A client created with a [CreateClient] request
        client: Arc<RawClient>,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to register a replay worker
    InitReplayWorker {
        /// Worker configuration. Must have unique task queue name.
        config: WorkerConfig,
        /// The history this worker should replay
        history: History,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to drain logs from core so they can be emitted in node
    PollLogs {
        /// Logs are sent to this function
        callback: Root<JsFunction>,
    },
}

enum WorkerRequest {
    /// A request to shutdown a worker, the worker instance will remain active to
    /// allow draining of pending tasks
    InitiateShutdown {
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for workflow activations
    PollWorkflowActivation {
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to complete a single workflow activation
    CompleteWorkflowActivation {
        completion: WorkflowActivationCompletion,
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for activity tasks
    PollActivityTask {
        otel_span: SpanContext,
        /// Used to report completion or error back into JS
        callback: Root<JsFunction>,
    },
    /// A request to complete a single activity task
    CompleteActivityTask {
        completion: ActivityTaskCompletion,
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to send a heartbeat from a running activity
    RecordActivityHeartbeat { heartbeat: ActivityHeartbeat },
}

struct RuntimeHandle {
    sender: UnboundedSender<RuntimeRequest>,
}

/// Box it so we can use the runtime from JS
type BoxedRuntime = JsBox<Arc<RuntimeHandle>>;
impl Finalize for RuntimeHandle {}

#[derive(Clone)]
struct Client {
    runtime: Arc<RuntimeHandle>,
    core_client: Arc<RawClient>,
}

type BoxedClient = JsBox<RefCell<Option<Client>>>;
impl Finalize for Client {}

/// Worker struct, hold a reference for the channel sender responsible for sending requests from
/// JS to a bridge thread which forwards them to core
struct WorkerHandle {
    sender: UnboundedSender<WorkerRequest>,
}

/// Box it so we can use Worker from JS
type BoxedWorker = JsBox<RefCell<Option<WorkerHandle>>>;
impl Finalize for WorkerHandle {}

/// Inits a multi-threaded tokio runtime used to interact with sdk-core APIs
fn tokio_runtime() -> Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("core")
        .build()
        .expect("Tokio runtime must construct properly")
}

/// Send a result to JS via callback using a [Channel]
fn send_result<F, T>(channel: Arc<Channel>, callback: Root<JsFunction>, res_fn: F)
where
    F: for<'a> FnOnce(&mut TaskContext<'a>) -> NeonResult<Handle<'a, T>> + Send + 'static,
    T: Value,
{
    channel.send(move |mut cx| {
        let callback = callback.into_inner(&mut cx);
        let this = cx.undefined();
        let error = cx.undefined();
        let result = res_fn(&mut cx)?;
        let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
        callback.call(&mut cx, this, args)?;
        Ok(())
    });
}

/// Send an error to JS via callback using a [Channel]
fn send_error<E, F>(channel: Arc<Channel>, callback: Root<JsFunction>, error_ctor: F)
where
    E: Object,
    F: for<'a> FnOnce(&mut TaskContext<'a>) -> JsResult<'a, E> + Send + 'static,
{
    channel.send(move |mut cx| {
        let callback = callback.into_inner(&mut cx);
        callback_with_error(&mut cx, callback, error_ctor)
    });
}

/// Call `callback` with given error
fn callback_with_error<'a, C, E, F>(
    cx: &mut C,
    callback: Handle<JsFunction>,
    error_ctor: F,
) -> NeonResult<()>
where
    C: Context<'a>,
    E: Object,
    F: FnOnce(&mut C) -> JsResult<'a, E> + Send + 'static,
{
    let this = cx.undefined();
    let error = error_ctor(cx)?;
    let result = cx.undefined();
    let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
    callback.call(cx, this, args)?;
    Ok(())
}

/// Call `callback` with an UnexpectedError created from `err`
fn callback_with_unexpected_error<'a, C, E>(
    cx: &mut C,
    callback: Handle<JsFunction>,
    err: E,
) -> NeonResult<()>
where
    C: Context<'a>,
    E: std::fmt::Display,
{
    let err_str = format!("{}", err);
    callback_with_error(cx, callback, move |cx| {
        UNEXPECTED_ERROR.from_string(cx, err_str)
    })
}

/// When Future completes, call given JS callback using a neon::Channel with either error or
/// undefined
async fn void_future_to_js<E, F, ER, EF>(
    channel: Arc<Channel>,
    callback: Root<JsFunction>,
    f: F,
    error_function: EF,
) where
    E: Display + Send + 'static,
    F: Future<Output = Result<(), E>> + Send,
    ER: Object,
    EF: for<'a> FnOnce(&mut TaskContext<'a>, E) -> JsResult<'a, ER> + Send + 'static,
{
    match f.await {
        Ok(()) => {
            send_result(channel, callback, |cx| Ok(cx.undefined()));
        }
        Err(err) => {
            send_error(channel, callback, |cx| error_function(cx, err));
        }
    }
}

/// Builds a tokio runtime and starts polling on [RuntimeRequest]s via an internal channel.
/// Bridges requests from JS to core and sends responses back to JS using a neon::Channel.
/// Blocks current thread until a [Shutdown] request is received in channel.
fn start_bridge_loop(channel: Arc<Channel>, receiver: &mut UnboundedReceiver<RuntimeRequest>) {
    tokio_runtime().block_on(async {
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
                    headers,
                    callback,
                } => {
                    // `metrics_meter` (second arg) can be None here since we don't use the
                    // returned client directly at the moment, when we repurpose the client to be
                    // used by a Worker, `init_worker` will attach the correct metrics meter for
                    // us.
                    tokio::spawn(async move {
                        match options
                            .connect_no_namespace(None, headers.map(|h| Arc::new(RwLock::new(h))))
                            .await
                        {
                            Err(err) => {
                                send_error(channel.clone(), callback, |cx| match err {
                                    ClientInitError::SystemInfoCallError(e) => TRANSPORT_ERROR
                                        .from_error(
                                            cx,
                                            format!("Failed to call GetSystemInfo: {}", e),
                                        ),
                                    ClientInitError::TonicTransportError(e) => {
                                        TRANSPORT_ERROR.from_error(cx, e)
                                    }
                                    ClientInitError::InvalidUri(e) => {
                                        Ok(JsError::type_error(cx, format!("{}", e))?.upcast())
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
                RuntimeRequest::PollLogs { callback } => {
                    let logs = fetch_global_buffered_logs();
                    send_result(channel.clone(), callback, |cx| {
                        let logarr = cx.empty_array();
                        for (i, cl) in logs.into_iter().enumerate() {
                            // Not much to do here except for panic when there's an
                            // error here.
                            let logobj = cx.empty_object();
                            let level = cx.string(cl.level.to_string());
                            logobj.set(cx, "level", level).unwrap();
                            let ts = system_time_to_js(cx, cl.timestamp).unwrap();
                            logobj.set(cx, "timestamp", ts).unwrap();
                            let msg = cx.string(cl.message);
                            logobj.set(cx, "message", msg).unwrap();
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
                    let worker =
                        init_worker(config, AnyClient::LowLevel(Box::new(client.into_inner())));
                    let (tx, rx) = unbounded_channel();
                    tokio::spawn(start_worker_loop(worker, rx, channel.clone()));
                    send_result(channel.clone(), callback, |cx| {
                        Ok(cx.boxed(RefCell::new(Some(WorkerHandle { sender: tx }))))
                    });
                }
                RuntimeRequest::InitReplayWorker {
                    config,
                    history,
                    callback,
                } => {
                    match init_replay_worker(config, &history) {
                        Ok(worker) => {
                            let (tx, rx) = unbounded_channel();
                            tokio::spawn(start_worker_loop(worker, rx, channel.clone()));
                            send_result(channel.clone(), callback, |cx| {
                                Ok(cx.boxed(RefCell::new(Some(WorkerHandle { sender: tx }))))
                            })
                        }
                        Err(err) => send_error(channel.clone(), callback, |cx| {
                            UNEXPECTED_ERROR.from_error(cx, err)
                        }),
                    };
                }
            }
        }
    })
}

/// Polls on [WorkerRequest]s via given channel.
/// Bridges requests from JS to core and sends responses back to JS using a neon::Channel.
/// Returns when the given channel is dropped.
async fn start_worker_loop(
    worker: CoreWorker,
    rx: UnboundedReceiver<WorkerRequest>,
    channel: Arc<Channel>,
) {
    UnboundedReceiverStream::new(rx)
        .for_each_concurrent(None, |request| {
            let worker = &worker;
            let channel = channel.clone();
            async move {
                match request {
                    WorkerRequest::InitiateShutdown { callback } => {
                        worker.initiate_shutdown();
                        send_result(channel, callback, |cx| Ok(cx.undefined()));
                    }
                    WorkerRequest::PollWorkflowActivation {
                        otel_span,
                        callback,
                    } => {
                        handle_poll_workflow_activation_request(
                            &worker, otel_span, channel, callback,
                        )
                        .await
                    }
                    WorkerRequest::PollActivityTask {
                        otel_span,
                        callback,
                    } => {
                        handle_poll_activity_task_request(&worker, otel_span, channel, callback)
                            .await
                    }
                    WorkerRequest::CompleteWorkflowActivation {
                        completion,
                        otel_span,
                        callback,
                    } => {
                        let otel_ctx =
                            opentelemetry::Context::new().with_remote_span_context(otel_span);
                        void_future_to_js(
                            channel,
                            callback,
                            async move {
                                worker
                                    .complete_workflow_activation(completion)
                                    .with_context(otel_ctx)
                                    .await
                            },
                            |cx, err| match err {
                                CompleteWfError::TonicError(_) => {
                                    TRANSPORT_ERROR.from_error(cx, err)
                                }
                                CompleteWfError::MalformedWorkflowCompletion { reason, .. } => {
                                    Ok(JsError::type_error(cx, reason)?.upcast())
                                }
                            },
                        )
                        .await;
                    }
                    WorkerRequest::CompleteActivityTask {
                        completion,
                        otel_span,
                        callback,
                    } => {
                        let otel_ctx =
                            opentelemetry::Context::new().with_remote_span_context(otel_span);
                        void_future_to_js(
                            channel,
                            callback,
                            async move {
                                worker
                                    .complete_activity_task(completion)
                                    .with_context(otel_ctx)
                                    .await
                            },
                            |cx, err| match err {
                                CompleteActivityError::MalformedActivityCompletion {
                                    reason,
                                    ..
                                } => Ok(JsError::type_error(cx, reason)?.upcast()),
                                CompleteActivityError::TonicError(_) => {
                                    TRANSPORT_ERROR.from_error(cx, err)
                                }
                            },
                        )
                        .await;
                    }
                    WorkerRequest::RecordActivityHeartbeat { heartbeat } => {
                        worker.record_activity_heartbeat(heartbeat)
                    }
                }
            }
        })
        .await;
    worker.finalize_shutdown().await;
}

/// Called within the poll loop thread, calls core and triggers JS callback with result
async fn handle_poll_workflow_activation_request(
    worker: &CoreWorker,
    span_context: SpanContext,
    channel: Arc<Channel>,
    callback: Root<JsFunction>,
) {
    let otel_ctx = opentelemetry::Context::new().with_remote_span_context(span_context);
    match worker
        .poll_workflow_activation()
        .with_context(otel_ctx)
        .await
    {
        Ok(task) => {
            send_result(channel, callback, move |cx| {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len)?;
                let mut slice = result.as_mut_slice(cx);
                if task.encode(&mut slice).is_err() {
                    panic!("Failed to encode task")
                };
                Ok(result)
            });
        }
        Err(err) => {
            send_error(channel, callback, move |cx| match err {
                PollWfError::ShutDown => SHUTDOWN_ERROR.from_error(cx, err),
                PollWfError::TonicError(_)
                | PollWfError::AutocompleteError(CompleteWfError::TonicError(_)) => {
                    TRANSPORT_ERROR.from_error(cx, err)
                }
                PollWfError::AutocompleteError(CompleteWfError::MalformedWorkflowCompletion {
                    reason,
                    ..
                }) => Ok(JsError::type_error(cx, reason)?.upcast()),
            });
        }
    }
}

/// Called within the poll loop thread, calls core and triggers JS callback with result
async fn handle_poll_activity_task_request(
    worker: &CoreWorker,
    span_context: SpanContext,
    channel: Arc<Channel>,
    callback: Root<JsFunction>,
) {
    let otel_ctx = opentelemetry::Context::new().with_remote_span_context(span_context);
    match worker.poll_activity_task().with_context(otel_ctx).await {
        Ok(task) => {
            send_result(channel, callback, move |cx| {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len)?;
                let mut slice = result.as_mut_slice(cx);
                if task.encode(&mut slice).is_err() {
                    panic!("Failed to encode task")
                };
                Ok(result)
            });
        }
        Err(err) => {
            send_error(channel, callback, move |cx| match err {
                PollActivityError::ShutDown => SHUTDOWN_ERROR.from_error(cx, err),
                PollActivityError::TonicError(_) => TRANSPORT_ERROR.from_error(cx, err),
            });
        }
    }
}

// Below are functions exported to JS

/// Initialize Core global telemetry.
/// This should typically be called once on process startup.
fn init_telemetry(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let telemetry_options = cx.argument::<JsObject>(0)?.as_telemetry_options(&mut cx)?;
    telemetry_init(&telemetry_options).map_err(|err| {
        cx.throw_type_error::<String, ()>(format!("{}", err))
            .unwrap_err()
    })?;
    Ok(cx.undefined())
}

/// Create the tokio runtime required to run Core.
/// Immediately spawns a poller thread that will block on [RuntimeRequest]s
fn runtime_new(mut cx: FunctionContext) -> JsResult<BoxedRuntime> {
    let channel = Arc::new(cx.channel());
    let (sender, mut receiver) = unbounded_channel::<RuntimeRequest>();

    std::thread::spawn(move || start_bridge_loop(channel, &mut receiver));

    Ok(cx.boxed(Arc::new(RuntimeHandle { sender })))
}

/// Create a connected gRPC client which can be used to initialize workers.
/// Client will be returned in the supplied `callback`.
fn client_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let opts = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let client_options = opts.as_client_options(&mut cx)?;
    let headers = match js_optional_getter!(&mut cx, &opts, "headers", JsObject) {
        None => None,
        Some(h) => Some(
            h.as_hash_map_of_string_to_string(&mut cx)
                .map_err(|reason| {
                    cx.throw_type_error::<_, HashMap<String, String>>(format!(
                        "Invalid headers: {}",
                        reason
                    ))
                    .unwrap_err()
                })?,
        ),
    };

    let request = RuntimeRequest::CreateClient {
        runtime: (**runtime).clone(),
        options: client_options,
        headers,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };

    Ok(cx.undefined())
}

/// Update a Client's HTTP request headers
fn client_update_headers(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let headers = cx
        .argument::<JsObject>(1)?
        .as_hash_map_of_string_to_string(&mut cx)?;
    let callback = cx.argument::<JsFunction>(2)?;

    match &*client.borrow() {
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

/// Create a new worker asynchronously.
/// Worker uses the provided connection and returned to JS using supplied `callback`.
fn worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let worker_options = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let config = worker_options.as_worker_config(&mut cx)?;
    match &*client.borrow() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Client")?;
        }
        Some(client) => {
            let request = RuntimeRequest::InitWorker {
                client: client.core_client.clone(),
                config,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = client.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
    };

    Ok(cx.undefined())
}

/// Create a new replay worker asynchronously.
/// Worker is returned to JS using supplied callback.
fn replay_worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let worker_options = cx.argument::<JsObject>(1)?;
    let history_binary = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;

    let config = worker_options.as_worker_config(&mut cx)?;
    let data = history_binary.as_slice(&mut cx);
    match History::decode_length_delimited(data) {
        Ok(history) => {
            let request = RuntimeRequest::InitReplayWorker {
                config,
                history,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
        Err(_) => callback_with_error(&mut cx, callback, |cx| {
            JsError::type_error(cx, "Cannot decode History from buffer")
        })?,
    }

    Ok(cx.undefined())
}

/// Shutdown the Core instance and break out of the thread loop
fn runtime_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
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
fn poll_logs(mut cx: FunctionContext) -> JsResult<JsUndefined> {
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

/// Initiate a single workflow activation poll request.
/// There should be only one concurrent poll request for this type.
fn worker_poll_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;
    match &*worker.borrow() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            let request = WorkerRequest::PollWorkflowActivation {
                otel_span: otel_span.as_otel_span_context(&mut cx)?,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            }
        }
    }
    Ok(cx.undefined())
}

/// Initiate a single activity task poll request.
/// There should be only one concurrent poll request for this type.
fn worker_poll_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;
    match &*worker.borrow() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            let request = WorkerRequest::PollActivityTask {
                otel_span: otel_span.as_otel_span_context(&mut cx)?,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            }
        }
    }
    Ok(cx.undefined())
}

/// Submit a workflow activation completion to core.
fn worker_complete_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let completion = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;
    match &*worker.borrow() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            match WorkflowActivationCompletion::decode_length_delimited(
                completion.as_slice(&mut cx),
            ) {
                Ok(completion) => {
                    let request = WorkerRequest::CompleteWorkflowActivation {
                        completion,
                        otel_span: otel_span.as_otel_span_context(&mut cx)?,
                        callback: callback.root(&mut cx),
                    };
                    if let Err(err) = worker.sender.send(request) {
                        callback_with_unexpected_error(&mut cx, callback, err)?;
                    };
                }
                Err(_) => callback_with_error(&mut cx, callback, |cx| {
                    JsError::type_error(cx, "Cannot decode Completion from buffer")
                })?,
            }
        }
    };
    Ok(cx.undefined())
}

/// Submit an activity task completion to core.
fn worker_complete_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let result = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;
    match &*worker.borrow() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            match ActivityTaskCompletion::decode_length_delimited(result.as_slice(&mut cx)) {
                Ok(completion) => {
                    let request = WorkerRequest::CompleteActivityTask {
                        completion,
                        otel_span: otel_span.as_otel_span_context(&mut cx)?,
                        callback: callback.root(&mut cx),
                    };
                    if let Err(err) = worker.sender.send(request) {
                        callback_with_unexpected_error(&mut cx, callback, err)?;
                    };
                }
                Err(_) => callback_with_error(&mut cx, callback, |cx| {
                    JsError::type_error(cx, "Cannot decode Completion from buffer")
                })?,
            }
        }
    };
    Ok(cx.undefined())
}

/// Submit an activity heartbeat to core.
fn worker_record_activity_heartbeat(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let heartbeat = cx.argument::<JsArrayBuffer>(1)?;
    match &*worker.borrow() {
        None => UNEXPECTED_ERROR
            .from_error(&mut cx, "Tried to use closed Worker")
            .and_then(|err| cx.throw(err))?,
        Some(worker) => {
            match ActivityHeartbeat::decode_length_delimited(heartbeat.as_slice(&mut cx)) {
                Ok(heartbeat) => {
                    let request = WorkerRequest::RecordActivityHeartbeat { heartbeat };
                    if let Err(err) = worker.sender.send(request) {
                        UNEXPECTED_ERROR
                            .from_error(&mut cx, err)
                            .and_then(|err| cx.throw(err))?;
                    }
                }
                Err(_) => cx.throw_type_error("Cannot decode ActivityHeartbeat from buffer")?,
            }
        }
    };
    Ok(cx.undefined())
}

/// Request shutdown of the worker.
/// Once complete Core will stop polling on new tasks and activations on worker's task queue.
/// Caller should drain any pending tasks and activations and call worker_finalize_shutdown before breaking from
/// the loop to ensure graceful shutdown.
fn worker_initiate_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    match &*worker.borrow() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            if let Err(err) = worker.sender.send(WorkerRequest::InitiateShutdown {
                callback: callback.root(&mut cx),
            }) {
                UNEXPECTED_ERROR
                    .from_error(&mut cx, err)
                    .and_then(|err| cx.throw(err))?;
            };
        }
    }
    Ok(cx.undefined())
}

fn worker_finalize_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    if worker.replace(None).is_none() {
        ILLEGAL_STATE_ERROR
            .from_error(&mut cx, "Worker already closed")
            .and_then(|err| cx.throw(err))?;
    }

    Ok(cx.undefined())
}

/// Drop a reference to a Client, once all references are dropped, the Client will be closed.
fn client_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    if client.replace(None).is_none() {
        ILLEGAL_STATE_ERROR
            .from_error(&mut cx, "Client already closed")
            .and_then(|err| cx.throw(err))?;
    };
    Ok(cx.undefined())
}

/// Convert Rust SystemTime into a JS array with 2 numbers (seconds, nanos)
fn system_time_to_js<'a, C>(cx: &mut C, time: SystemTime) -> NeonResult<Handle<'a, JsArray>>
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
fn get_time_of_day(mut cx: FunctionContext) -> JsResult<JsArray> {
    system_time_to_js(&mut cx, SystemTime::now())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("getTimeOfDay", get_time_of_day)?;
    cx.export_function("registerErrors", errors::register_errors)?;
    cx.export_function("initTelemetry", init_telemetry)?;
    cx.export_function("newRuntime", runtime_new)?;
    cx.export_function("newClient", client_new)?;
    cx.export_function("clientUpdateHeaders", client_update_headers)?;
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("newReplayWorker", replay_worker_new)?;
    cx.export_function("workerInitiateShutdown", worker_initiate_shutdown)?;
    cx.export_function("workerFinalizeShutdown", worker_finalize_shutdown)?;
    cx.export_function("clientClose", client_close)?;
    cx.export_function("runtimeShutdown", runtime_shutdown)?;
    cx.export_function("pollLogs", poll_logs)?;
    cx.export_function(
        "workerPollWorkflowActivation",
        worker_poll_workflow_activation,
    )?;
    cx.export_function("workerPollActivityTask", worker_poll_activity_task)?;
    cx.export_function(
        "workerCompleteWorkflowActivation",
        worker_complete_workflow_activation,
    )?;
    cx.export_function("workerCompleteActivityTask", worker_complete_activity_task)?;
    cx.export_function(
        "workerRecordActivityHeartbeat",
        worker_record_activity_heartbeat,
    )?;
    Ok(())
}
