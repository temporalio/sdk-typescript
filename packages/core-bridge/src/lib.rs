mod conversions;
mod errors;

use crate::conversions::ObjectHandleConversionsExt;
use errors::*;
use neon::prelude::*;
use opentelemetry::trace::{FutureExt, SpanContext, TraceContextExt};
use prost::Message;
use std::{
    fmt::Display,
    future::Future,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use temporal_sdk_core::{
    errors::{
        CompleteActivityError, CompleteWfError, CoreInitError, PollActivityError, PollWfError,
    },
    init, Core, CoreInitOptions, CoreInitOptionsBuilder, WorkerConfig,
};
use temporal_sdk_core_protos::coresdk::{
    workflow_completion::WfActivationCompletion, ActivityHeartbeat, ActivityTaskCompletion,
};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// A request from JS to bridge to core
pub enum Request {
    /// A request to shutdown Core, any registered workers will be shutdown as well.
    /// Breaks from the thread loop.
    Shutdown {
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to shutdown a worker, the worker instance will remain active to
    /// allow draining of pending tasks
    ShutdownWorker {
        task_queue: String,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to register a new Worker against Core
    RegisterWorker {
        /// Worker configuration e.g. limits and task queue
        config: WorkerConfig,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for workflow activations
    PollWorkflowActivation {
        /// Name of queue to poll on
        queue_name: String,
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to complete a single workflow activation
    CompleteWorkflowActivation {
        completion: WfActivationCompletion,
        otel_span: SpanContext,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for activity tasks
    PollActivityTask {
        /// Name of queue to poll on
        queue_name: String,
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
    /// A request to drain logs from core so they can be emitted in node
    PollLogs {
        /// Logs are sent to this function
        callback: Root<JsFunction>,
    },
}

#[derive(Clone)]
pub struct CoreHandle {
    sender: UnboundedSender<Request>,
}

/// Box it so we can use Core from JS
type BoxedCore = JsBox<CoreHandle>;

impl Finalize for CoreHandle {}

/// Worker struct, hold a reference for the channel sender responsible for sending requests from
/// JS to a bridge thread which forwards them to core
pub struct Worker {
    core: CoreHandle,
    queue: String,
}

/// Box it so we can use Worker from JS
type BoxedWorker = JsBox<Worker>;

impl Finalize for Worker {}

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
fn start_bridge_loop(
    core_init_options: CoreInitOptions,
    event_queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    let (sender, mut receiver) = unbounded_channel::<Request>();

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            match init(core_init_options).await {
                Err(err) => {
                    send_error(event_queue.clone(), callback, |cx| match err {
                        CoreInitError::InvalidUri(_) => {
                            Ok(JsError::type_error(cx, "Invalid URI")?.upcast())
                        }
                        CoreInitError::TonicTransportError(err) => {
                            TRANSPORT_ERROR.from_error(cx, err)
                        }
                        e @ CoreInitError::TelemetryInitError(_) => {
                            UNEXPECTED_ERROR.from_error(cx, e)
                        }
                    });
                }
                Ok(result) => {
                    let core = Arc::new(result);
                    let core_handle = CoreHandle {
                        sender: sender.clone(),
                    };
                    // Clone once to send back to JS via event queue
                    let cloned_core_handle = core_handle.clone();
                    send_result(event_queue.clone(), callback, |cx| {
                        Ok(cx.boxed(cloned_core_handle))
                    });

                    loop {
                        let request_option = receiver.recv().await;
                        let request = match request_option {
                            None => break,
                            Some(request) => request,
                        };
                        let core = core.clone();
                        let event_queue = event_queue.clone();

                        match request {
                            Request::Shutdown { callback } => {
                                void_future_to_js(
                                    event_queue,
                                    callback,
                                    async move {
                                        core.shutdown().await;
                                        // Wrap the empty result in a valid Result object
                                        let result: Result<(), String> = Ok(());
                                        result
                                    },
                                    |cx, err| UNEXPECTED_ERROR.from_error(cx, err),
                                )
                                .await;
                                break;
                            }
                            Request::PollLogs { callback } => {
                                let logs = core.fetch_buffered_logs();
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
                            Request::ShutdownWorker {
                                task_queue,
                                callback,
                            } => {
                                tokio::spawn(void_future_to_js(
                                    event_queue,
                                    callback,
                                    async move {
                                        core.shutdown_worker(&task_queue).await;
                                        // Wrap the empty result in a valid Result object
                                        let result: Result<(), String> = Ok(());
                                        result
                                    },
                                    |cx, err| UNEXPECTED_ERROR.from_error(cx, err),
                                ));
                            }
                            Request::RegisterWorker { config, callback } => {
                                let task_queue = config.clone().task_queue;
                                let core_handle = core_handle.clone();
                                tokio::spawn(async move {
                                    match core.register_worker(config).await {
                                        Ok(_) => send_result(event_queue.clone(), callback, |cx| {
                                            Ok(cx.boxed(Worker {
                                                core: core_handle,
                                                queue: task_queue,
                                            }))
                                        }),
                                        Err(err) => {
                                            send_error(event_queue.clone(), callback, |cx| {
                                                UNEXPECTED_ERROR.from_error(cx, err)
                                            })
                                        }
                                    };
                                });
                            }
                            Request::PollWorkflowActivation {
                                queue_name,
                                otel_span,
                                callback,
                            } => {
                                tokio::spawn(handle_poll_workflow_activation_request(
                                    queue_name,
                                    otel_span,
                                    core,
                                    event_queue,
                                    callback,
                                ));
                            }
                            Request::PollActivityTask {
                                queue_name,
                                otel_span,
                                callback,
                            } => {
                                tokio::spawn(handle_poll_activity_task_request(
                                    queue_name,
                                    otel_span,
                                    core,
                                    event_queue,
                                    callback,
                                ));
                            }
                            Request::CompleteWorkflowActivation {
                                completion,
                                otel_span,
                                callback,
                            } => {
                                let otel_ctx = opentelemetry::Context::new()
                                    .with_remote_span_context(otel_span);
                                tokio::spawn(void_future_to_js(
                                    event_queue,
                                    callback,
                                    async move {
                                        core.complete_workflow_activation(completion)
                                            .with_context(otel_ctx)
                                            .await
                                    },
                                    |cx, err| match err {
                                        CompleteWfError::NoWorkerForQueue(queue_name) => {
                                            let args = vec![cx.string(queue_name).upcast()];
                                            NO_WORKER_ERROR.construct(cx, args)
                                        }
                                        CompleteWfError::TonicError(_) => {
                                            TRANSPORT_ERROR.from_error(cx, err)
                                        }
                                        CompleteWfError::MalformedWorkflowCompletion {
                                            reason,
                                            ..
                                        } => Ok(JsError::type_error(cx, reason)?.upcast()),
                                    },
                                ));
                            }
                            Request::CompleteActivityTask {
                                completion,
                                otel_span,
                                callback,
                            } => {
                                let otel_ctx = opentelemetry::Context::new()
                                    .with_remote_span_context(otel_span);
                                tokio::spawn(void_future_to_js(
                                    event_queue,
                                    callback,
                                    async move {
                                        core.complete_activity_task(completion)
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
                                        CompleteActivityError::NoWorkerForQueue(queue_name) => {
                                            let args = vec![cx.string(queue_name).upcast()];
                                            NO_WORKER_ERROR.construct(cx, args)
                                        }
                                    },
                                ));
                            }
                            Request::RecordActivityHeartbeat { heartbeat } => {
                                core.record_activity_heartbeat(heartbeat)
                            }
                        }
                    }
                }
            }
        })
}

/// Called within the poll loop thread, calls core and triggers JS callback with result
async fn handle_poll_workflow_activation_request(
    queue_name: String,
    span_context: SpanContext,
    core: Arc<impl Core>,
    event_queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    let otel_ctx = opentelemetry::Context::new().with_remote_span_context(span_context);
    match core
        .poll_workflow_activation(queue_name.as_str())
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
                    UNEXPECTED_ERROR
                        .from_error(cx, format!("No worker registered for queue {}", queue_name))
                }
                PollWfError::NoWorkerForQueue(queue_name) => {
                    let args = vec![cx.string(queue_name).upcast()];
                    NO_WORKER_ERROR.construct(cx, args)
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
    queue_name: String,
    span_context: SpanContext,
    core: Arc<impl Core>,
    event_queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    let otel_ctx = opentelemetry::Context::new().with_remote_span_context(span_context);
    match core
        .poll_activity_task(queue_name.as_str())
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
                PollActivityError::ShutDown => SHUTDOWN_ERROR.from_error(cx, err),
                PollActivityError::NoWorkerForQueue(queue_name) => {
                    let args = vec![cx.string(queue_name).upcast()];
                    NO_WORKER_ERROR.construct(cx, args)
                }
                PollActivityError::TonicError(_) => TRANSPORT_ERROR.from_error(cx, err),
            });
        }
    }
}

// Below are functions exported to JS

/// Create a new core instance asynchronously.
/// Immediately spawns a poller thread that will block on [Request]s
/// Core is returned to JS using supplied callback
fn core_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let core_options = cx.argument::<JsObject>(0)?;
    let server_options = core_options
        .get(&mut cx, "serverOptions")?
        .downcast_or_throw::<JsObject, _>(&mut cx)?;
    let telem_options = core_options
        .get(&mut cx, "telemetryOptions")?
        .downcast_or_throw::<JsObject, _>(&mut cx)?;

    let gateway_opts = server_options.as_server_gateway_options(&mut cx)?;
    let telemetry_opts = telem_options.as_telemetry_options(&mut cx)?;

    let callback = cx.argument::<JsFunction>(1)?.root(&mut cx);
    let queue = Arc::new(cx.queue());
    std::thread::spawn(move || {
        start_bridge_loop(
            CoreInitOptionsBuilder::default()
                .gateway_opts(gateway_opts)
                .telemetry_opts(telemetry_opts)
                .build()
                .expect("Core init options must be valid"),
            queue,
            callback,
        )
    });

    Ok(cx.undefined())
}

/// Create a new worker asynchronously.
/// Worker is registered on supplied core instance and returned to JS using supplied callback.
fn worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let core = cx.argument::<BoxedCore>(0)?;
    let worker_options = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let config = worker_options.as_worker_config(&mut cx)?;

    let request = Request::RegisterWorker {
        config,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = core.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };

    Ok(cx.undefined())
}

/// Shutdown the Core instance and break out of the thread loop
fn core_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let core = cx.argument::<BoxedCore>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let request = Request::Shutdown {
        callback: callback.root(&mut cx),
    };
    if let Err(err) = core.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };
    Ok(cx.undefined())
}

/// Request to drain forwarded logs from core
fn core_poll_logs(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let core = cx.argument::<BoxedCore>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let request = Request::PollLogs {
        callback: callback.root(&mut cx),
    };
    if let Err(err) = core.sender.send(request) {
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
        queue_name: worker.queue.clone(),
        otel_span: otel_span.as_otel_span_context(&mut cx)?,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.core.sender.send(request) {
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
        queue_name: worker.queue.clone(),
        otel_span: otel_span.as_otel_span_context(&mut cx)?,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.core.sender.send(request) {
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
        WfActivationCompletion::decode_length_delimited(data.as_slice::<u8>())
    });
    match result {
        Ok(completion) => {
            // Add the task queue from our Worker
            let completion = WfActivationCompletion {
                task_queue: worker.queue.clone(),
                ..completion
            };
            let request = Request::CompleteWorkflowActivation {
                completion,
                otel_span: otel_span.as_otel_span_context(&mut cx)?,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.core.sender.send(request) {
                callback_with_error(&mut cx, callback, |cx| UNEXPECTED_ERROR.from_error(cx, err))?;
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
            // Add the task queue from our Worker
            let completion = ActivityTaskCompletion {
                task_queue: worker.queue.clone(),
                ..completion
            };
            let request = Request::CompleteActivityTask {
                completion,
                otel_span: otel_span.as_otel_span_context(&mut cx)?,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.core.sender.send(request) {
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
            // Add the task queue from our Worker
            let heartbeat = ActivityHeartbeat {
                task_queue: worker.queue.clone(),
                ..heartbeat
            };
            let request = Request::RecordActivityHeartbeat { heartbeat };
            match worker.core.sender.send(request) {
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
    match worker.core.sender.send(Request::ShutdownWorker {
        task_queue: worker.queue.clone(),
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
    return Ok(ts);
}

/// Helper to get the current time in nanosecond resolution.
fn get_time_of_day(mut cx: FunctionContext) -> JsResult<JsArray> {
    system_time_to_js(&mut cx, SystemTime::now())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("getTimeOfDay", get_time_of_day)?;
    cx.export_function("registerErrors", errors::register_errors)?;
    cx.export_function("newCore", core_new)?;
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("workerShutdown", worker_shutdown)?;
    cx.export_function("coreShutdown", core_shutdown)?;
    cx.export_function("corePollLogs", core_poll_logs)?;
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
