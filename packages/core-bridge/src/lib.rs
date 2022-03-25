mod conversions;
mod errors;

use crate::conversions::ObjectHandleConversionsExt;
use errors::*;
use neon::prelude::*;
use once_cell::sync::OnceCell;
use opentelemetry::trace::{FutureExt, SpanContext, TraceContextExt};
use prost::Message;
use std::{
    fmt::Display,
    future::Future,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use temporal_client::ClientInitError;
use temporal_sdk_core::{
    api::{
        errors::{CompleteActivityError, CompleteWfError, PollActivityError, PollWfError},
        Worker as CoreWorker,
    },
    fetch_global_buffered_logs, init_replay_worker, init_worker,
    protos::{
        coresdk::{
            workflow_completion::WorkflowActivationCompletion, ActivityHeartbeat,
            ActivityTaskCompletion,
        },
        temporal::api::history::v1::History,
    },
    telemetry_init, Client as CoreClient, ClientOptions, RetryClient, WorkerConfig,
};
use tokio::{
    runtime::Runtime,
    sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
};

/// A request from JS to bridge to core
enum Request {
    /// A request to shutdown the runtime, breaks from the thread loop.
    Shutdown {
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to create a client in a runtime
    CreateClient {
        runtime: Arc<ThreadRuntime>,
        options: ClientOptions,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to shutdown a worker, the worker instance will remain active to
    /// allow draining of pending tasks
    ShutdownWorker {
        worker: Arc<dyn CoreWorker>,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to create a new Worker using a connected client
    InitWorker {
        runtime: Arc<ThreadRuntime>,
        /// Worker configuration e.g. limits and task queue
        config: WorkerConfig,
        /// A client created with a [CreateClient] request
        client: Arc<RetryClient<CoreClient>>,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to register a replay worker
    InitReplayWorker {
        runtime: Arc<ThreadRuntime>,
        /// Worker configuration. Must have unique task queue name.
        config: WorkerConfig,
        /// The history this worker should replay
        history: History,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for workflow activations
    PollWorkflowActivation {
        worker: Arc<dyn CoreWorker>,
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to complete a single workflow activation
    CompleteWorkflowActivation {
        worker: Arc<dyn CoreWorker>,
        completion: WorkflowActivationCompletion,
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for activity tasks
    PollActivityTask {
        worker: Arc<dyn CoreWorker>,
        otel_span: SpanContext,
        /// Used to report completion or error back into JS
        callback: Root<JsFunction>,
    },
    /// A request to complete a single activity task
    CompleteActivityTask {
        worker: Arc<dyn CoreWorker>,
        completion: ActivityTaskCompletion,
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to send a heartbeat from a running activity
    RecordActivityHeartbeat {
        worker: Arc<dyn CoreWorker>,
        heartbeat: ActivityHeartbeat,
    },
    /// A request to drain logs from core so they can be emitted in node
    PollLogs {
        /// Logs are sent to this function
        callback: Root<JsFunction>,
    },
}

struct ThreadRuntime {
    sender: UnboundedSender<Request>,
}

/// Box it so we can use the runtime from JS
type BoxedRuntime = JsBox<Arc<ThreadRuntime>>;
impl Finalize for ThreadRuntime {}

#[derive(Clone)]
struct Client {
    runtime: Arc<ThreadRuntime>,
    core_client: Arc<RetryClient<CoreClient>>,
}

type BoxedClient = JsBox<Client>;
impl Finalize for Client {}

/// Worker struct, hold a reference for the channel sender responsible for sending requests from
/// JS to a bridge thread which forwards them to core
struct Worker {
    runtime: Arc<ThreadRuntime>,
    core_worker: Arc<dyn CoreWorker>,
}

/// Box it so we can use Worker from JS
type BoxedWorker = JsBox<Worker>;
impl Finalize for Worker {}

/// Lazy-inits or returns a global tokio runtime that we use for interactions with Core(s)
fn tokio_runtime() -> &'static Runtime {
    static INSTANCE: OnceCell<Runtime> = OnceCell::new();
    INSTANCE.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("core")
            .build()
            .expect("Tokio runtime must construct properly")
    })
}

/// Send a result to JS via callback using an [EventQueue]
fn send_result<F, T>(queue: Arc<EventQueue>, callback: Root<JsFunction>, res_fn: F)
where
    F: for<'a> FnOnce(&mut TaskContext<'a>) -> NeonResult<Handle<'a, T>> + Send + 'static,
    T: Value,
{
    queue.send(move |mut cx| {
        let callback = callback.into_inner(&mut cx);
        let this = cx.undefined();
        let error = cx.undefined();
        let result = res_fn(&mut cx)?;
        let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
        callback.call(&mut cx, this, args)?;
        Ok(())
    });
}

/// Send an error to JS via callback using an [EventQueue]
fn send_error<E, F>(queue: Arc<EventQueue>, callback: Root<JsFunction>, error_ctor: F)
where
    E: Object,
    F: for<'a> FnOnce(&mut TaskContext<'a>) -> JsResult<'a, E> + Send + 'static,
{
    queue.send(move |mut cx| {
        let callback = callback.into_inner(&mut cx);
        callback_with_error(&mut cx, callback, error_ctor)
    });
}

/// Call [callback] with given error
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

/// Call [callback] with an UnexpectedError created from [err]
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

/// When Future completes, call given JS callback using a neon::EventQueue with either error or
/// undefined
async fn void_future_to_js<E, F, ER, EF>(
    queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
    f: F,
    error_function: EF,
) where
    E: Display + Send + 'static,
    F: Future<Output = Result<(), E>> + Send + 'static,
    ER: Object,
    EF: for<'a> FnOnce(&mut TaskContext<'a>, E) -> JsResult<'a, ER> + Send + 'static,
{
    match f.await {
        Ok(()) => {
            send_result(queue, callback, |cx| Ok(cx.undefined()));
        }
        Err(err) => {
            send_error(queue, callback, |cx| error_function(cx, err));
        }
    }
}

/// Builds a tokio runtime and starts polling on [Request]s via an internal channel.
/// Bridges requests from JS to core and sends responses back to JS using a neon::EventQueue.
/// Blocks current thread until a [BreakPoller] request is received in channel.
fn start_bridge_loop(event_queue: Arc<EventQueue>, receiver: &mut UnboundedReceiver<Request>) {
    tokio_runtime().block_on(async {
        loop {
            let request_option = receiver.recv().await;
            let request = match request_option {
                None => break,
                Some(request) => request,
            };

            let event_queue = event_queue.clone();

            match request {
                Request::Shutdown { callback } => {
                    send_result(event_queue, callback, |cx| Ok(cx.undefined()));
                    break;
                }
                Request::CreateClient {
                    runtime,
                    options,
                    callback,
                } => {
                    // The namespace here isn't really used, the Client is repurposed when a Worker
                    // is created, hardcode to default.
                    // `metrics_meter` (second arg) can be None here since we don't use the
                    // returned client directly at the moment, when we repurpose the client to be
                    // used by a Worker, `init_worker` will attach the correct metrics meter for
                    // us.
                    match options.connect("default", None).await {
                        Err(err) => {
                            send_error(event_queue.clone(), callback, |cx| match err {
                                ClientInitError::SystemInfoCallError(e) => TRANSPORT_ERROR
                                    .from_error(cx, format!("Failed to call GetSystemInfo: {}", e)),
                                ClientInitError::TonicTransportError(e) => {
                                    TRANSPORT_ERROR.from_error(cx, e)
                                }
                                ClientInitError::InvalidUri(e) => {
                                    Ok(JsError::type_error(cx, format!("{}", e))?.upcast())
                                }
                            });
                        }
                        Ok(client) => {
                            send_result(event_queue.clone(), callback, |cx| {
                                Ok(cx.boxed(Client {
                                    runtime,
                                    core_client: Arc::new(client),
                                }))
                            });
                        }
                    }
                }
                Request::PollLogs { callback } => {
                    let logs = fetch_global_buffered_logs();
                    send_result(event_queue.clone(), callback, |cx| {
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
                Request::ShutdownWorker { worker, callback } => {
                    tokio::spawn(void_future_to_js(
                        event_queue,
                        callback,
                        async move {
                            worker.shutdown().await;
                            // Wrap the empty result in a valid Result object
                            let result: Result<(), String> = Ok(());
                            result
                        },
                        |cx, err| UNEXPECTED_ERROR.from_error(cx, err),
                    ));
                }
                Request::InitWorker {
                    runtime,
                    config,
                    client,
                    callback,
                } => {
                    let worker = init_worker(config, client);
                    send_result(event_queue.clone(), callback, |cx| {
                        Ok(cx.boxed(Worker {
                            core_worker: Arc::new(worker),
                            runtime,
                        }))
                    });
                }
                Request::InitReplayWorker {
                    runtime,
                    config,
                    history,
                    callback,
                } => {
                    match init_replay_worker(config, &history) {
                        Ok(worker) => send_result(event_queue.clone(), callback, |cx| {
                            Ok(cx.boxed(Worker {
                                core_worker: Arc::new(worker),
                                runtime,
                            }))
                        }),
                        Err(err) => send_error(event_queue.clone(), callback, |cx| {
                            UNEXPECTED_ERROR.from_error(cx, err)
                        }),
                    };
                }
                Request::PollWorkflowActivation {
                    worker,
                    otel_span,
                    callback,
                } => {
                    tokio::spawn(async move {
                        handle_poll_workflow_activation_request(
                            &*worker,
                            otel_span,
                            event_queue,
                            callback,
                        )
                        .await
                    });
                }
                Request::PollActivityTask {
                    worker,
                    otel_span,
                    callback,
                } => {
                    tokio::spawn(async move {
                        handle_poll_activity_task_request(
                            &*worker,
                            otel_span,
                            event_queue,
                            callback,
                        )
                        .await
                    });
                }
                Request::CompleteWorkflowActivation {
                    worker,
                    completion,
                    otel_span,
                    callback,
                } => {
                    let otel_ctx =
                        opentelemetry::Context::new().with_remote_span_context(otel_span);
                    tokio::spawn(void_future_to_js(
                        event_queue,
                        callback,
                        async move {
                            worker
                                .complete_workflow_activation(completion)
                                .with_context(otel_ctx)
                                .await
                        },
                        |cx, err| match err {
                            CompleteWfError::NoWorkerForQueue(queue_name) => {
                                let args = vec![cx.string(queue_name).upcast()];
                                NO_WORKER_ERROR.construct(cx, args)
                            }
                            CompleteWfError::TonicError(_) => TRANSPORT_ERROR.from_error(cx, err),
                            CompleteWfError::MalformedWorkflowCompletion { reason, .. } => {
                                Ok(JsError::type_error(cx, reason)?.upcast())
                            }
                        },
                    ));
                }
                Request::CompleteActivityTask {
                    worker,
                    completion,
                    otel_span,
                    callback,
                } => {
                    let otel_ctx =
                        opentelemetry::Context::new().with_remote_span_context(otel_span);
                    tokio::spawn(void_future_to_js(
                        event_queue,
                        callback,
                        async move {
                            worker
                                .complete_activity_task(completion)
                                .with_context(otel_ctx)
                                .await
                        },
                        |cx, err| match err {
                            CompleteActivityError::MalformedActivityCompletion {
                                reason, ..
                            } => Ok(JsError::type_error(cx, reason)?.upcast()),
                            CompleteActivityError::TonicError(_) => {
                                TRANSPORT_ERROR.from_error(cx, err)
                            }
                            CompleteActivityError::NoWorkerForQueue(queue_name) => {
                                let args = vec![cx.string(queue_name).upcast()];
                                NO_WORKER_ERROR.construct(cx, args)
                            }
                        },
                    ));
                }
                Request::RecordActivityHeartbeat { worker, heartbeat } => {
                    worker.record_activity_heartbeat(heartbeat)
                }
            }
        }
    })
}

/// Called within the poll loop thread, calls core and triggers JS callback with result
async fn handle_poll_workflow_activation_request(
    worker: &dyn CoreWorker,
    span_context: SpanContext,
    event_queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    let otel_ctx = opentelemetry::Context::new().with_remote_span_context(span_context);
    match worker
        .poll_workflow_activation()
        .with_context(otel_ctx)
        .await
    {
        Ok(task) => {
            send_result(event_queue, callback, move |cx| {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len as u32)?;
                cx.borrow_mut(&mut result, |data| {
                    let mut slice = data.as_mut_slice::<u8>();
                    if task.encode(&mut slice).is_err() {
                        panic!("Failed to encode task")
                    };
                });
                Ok(result)
            });
        }
        Err(err) => {
            send_error(event_queue, callback, move |cx| match err {
                PollWfError::ShutDown => SHUTDOWN_ERROR.from_error(cx, err),
                PollWfError::AutocompleteError(CompleteWfError::NoWorkerForQueue(_)) => {
                    UNEXPECTED_ERROR.from_error(cx, "TODO this error shouldn't exist")
                }
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
    worker: &dyn CoreWorker,
    span_context: SpanContext,
    event_queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    let otel_ctx = opentelemetry::Context::new().with_remote_span_context(span_context);
    match worker.poll_activity_task().with_context(otel_ctx).await {
        Ok(task) => {
            send_result(event_queue, callback, move |cx| {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len as u32)?;
                cx.borrow_mut(&mut result, |data| {
                    let mut slice = data.as_mut_slice::<u8>();
                    if task.encode(&mut slice).is_err() {
                        panic!("Failed to encode task")
                    };
                });
                Ok(result)
            });
        }
        Err(err) => {
            send_error(event_queue, callback, move |cx| match err {
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
/// Immediately spawns a poller thread that will block on [Request]s
fn runtime_new(mut cx: FunctionContext) -> JsResult<BoxedRuntime> {
    let queue = Arc::new(cx.queue());
    let (sender, mut receiver) = unbounded_channel::<Request>();

    std::thread::spawn(move || start_bridge_loop(queue, &mut receiver));

    Ok(cx.boxed(Arc::new(ThreadRuntime { sender })))
}

/// Create a connected gRPC client which can be used to initialize workers with.
/// Client will be returned in the supplied [callback].
fn client_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let client_options = cx.argument::<JsObject>(1)?.as_client_options(&mut cx)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let request = Request::CreateClient {
        runtime: (**runtime).clone(),
        options: client_options,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };

    Ok(cx.undefined())
}

/// Create a new worker asynchronously.
/// Worker uses the provided connection and returned to JS using supplied [callback].
fn worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let worker_options = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let config = worker_options.as_worker_config(&mut cx)?;

    let request = Request::InitWorker {
        client: client.core_client.clone(),
        runtime: client.runtime.clone(),
        config,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = client.runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
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

    match cx.borrow(&history_binary, |data| {
        History::decode_length_delimited(data.as_slice::<u8>())
    }) {
        Ok(history) => {
            let request = Request::InitReplayWorker {
                runtime: (**runtime).clone(),
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
    let request = Request::Shutdown {
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
    let request = Request::PollLogs {
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
    let request = Request::PollWorkflowActivation {
        worker: worker.core_worker.clone(),
        otel_span: otel_span.as_otel_span_context(&mut cx)?,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    }
    Ok(cx.undefined())
}

/// Initiate a single activity task poll request.
/// There should be only one concurrent poll request for this type.
fn worker_poll_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;
    let request = Request::PollActivityTask {
        worker: worker.core_worker.clone(),
        otel_span: otel_span.as_otel_span_context(&mut cx)?,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    }
    Ok(cx.undefined())
}

/// Submit a workflow activation completion to core.
fn worker_complete_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let completion = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;
    let result = cx.borrow(&completion, |data| {
        WorkflowActivationCompletion::decode_length_delimited(data.as_slice::<u8>())
    });
    match result {
        Ok(completion) => {
            let request = Request::CompleteWorkflowActivation {
                worker: worker.core_worker.clone(),
                completion,
                otel_span: otel_span.as_otel_span_context(&mut cx)?,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
        Err(_) => callback_with_error(&mut cx, callback, |cx| {
            JsError::type_error(cx, "Cannot decode Completion from buffer")
        })?,
    };
    Ok(cx.undefined())
}

/// Submit an activity task completion to core.
fn worker_complete_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let result = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;
    let result = cx.borrow(&result, |data| {
        ActivityTaskCompletion::decode_length_delimited(data.as_slice::<u8>())
    });
    match result {
        Ok(completion) => {
            let request = Request::CompleteActivityTask {
                worker: worker.core_worker.clone(),
                completion,
                otel_span: otel_span.as_otel_span_context(&mut cx)?,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
        Err(_) => callback_with_error(&mut cx, callback, |cx| {
            JsError::type_error(cx, "Cannot decode Completion from buffer")
        })?,
    };
    Ok(cx.undefined())
}

/// Submit an activity heartbeat to core.
fn worker_record_activity_heartbeat(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let heartbeat = cx.argument::<JsArrayBuffer>(1)?;
    let heartbeat = cx.borrow(&heartbeat, |data| {
        ActivityHeartbeat::decode_length_delimited(data.as_slice::<u8>())
    });
    match heartbeat {
        Ok(heartbeat) => {
            let request = Request::RecordActivityHeartbeat {
                worker: worker.core_worker.clone(),
                heartbeat,
            };
            match worker.runtime.sender.send(request) {
                Err(err) => UNEXPECTED_ERROR
                    .from_error(&mut cx, err)
                    .and_then(|err| cx.throw(err)),
                _ => Ok(cx.undefined()),
            }
        }
        Err(_) => cx.throw_type_error("Cannot decode ActivityHeartbeat from buffer"),
    }
}

/// Request shutdown of the worker.
/// Once complete Core will stop polling on new tasks and activations on worker's task queue.
/// Caller should drain any pending tasks and activations before breaking from
/// the loop to ensure graceful shutdown.
fn worker_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    match worker.runtime.sender.send(Request::ShutdownWorker {
        worker: worker.core_worker.clone(),
        callback: callback.root(&mut cx),
    }) {
        Err(err) => cx.throw_error(format!("{}", err)),
        _ => Ok(cx.undefined()),
    }
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
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("newReplayWorker", replay_worker_new)?;
    cx.export_function("workerShutdown", worker_shutdown)?;
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
