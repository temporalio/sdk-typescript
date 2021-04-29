mod errors;

use errors::*;
use neon::prelude::*;
use prost::Message;
use std::{fmt::Display, future::Future, sync::Arc, time::Duration};
use temporal_sdk_core::{
    init, protos::coresdk::workflow_completion::WfActivationCompletion,
    protos::coresdk::ActivityHeartbeat, protos::coresdk::ActivityTaskCompletion, tracing_init,
    ActivityHeartbeatError, CompleteActivityError, CompleteWfError, Core, CoreInitError,
    CoreInitOptions, PollActivityError, PollWfError, ServerGatewayOptions, Url,
};
use tokio::sync::mpsc::{channel, Sender};

/// A request from JS to bridge to core
pub enum Request {
    /// A request to break from the thread loop, should be sent from JS when it
    /// encounters when core shutdown() resolves and there are no outstanding
    /// completions
    BreakLoop { callback: Root<JsFunction> },
    /// A request to shutdown core, the core instance will remain active to
    /// allow draining of pending tasks
    Shutdown {
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for workflow activations
    PollWorkflowActivation {
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to complete a single workflow activation
    CompleteWorkflowActivation {
        completion: WfActivationCompletion,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to poll for activity tasks
    PollActivityTask {
        /// Used to report completion or error back into JS
        callback: Root<JsFunction>,
    },
    /// A request to complete a single activity task
    CompleteActivityTask {
        completion: ActivityTaskCompletion,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
    /// A request to send a heartbeat from a running activity
    RecordActivityHeartbeat {
        heartbeat: ActivityHeartbeat,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
}

/// Worker struct, hold a reference for the channel sender responsible for sending requests from
/// JS to a bridge thread which forwards them to core
pub struct Worker {
    sender: Sender<Request>,
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

/// When Future completes, call given JS callback using a neon::EventQueue with either error or
/// undefined
async fn void_future_to_js<E, F, ER, EF>(
    queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
    f: F,
    error_function: EF,
) -> ()
where
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
    queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    // TODO: make capacity configurable
    let (sender, mut receiver) = channel::<Request>(1000);

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            match init(core_init_options).await {
                Err(err) => {
                    send_error(queue.clone(), callback, |cx| match err {
                        CoreInitError::InvalidUri(_) => {
                            Ok(JsError::type_error(cx, "Invalid URI")?.upcast())
                        }
                        CoreInitError::TonicTransportError(err) => {
                            TRANSPORT_ERROR.from_error(cx, err)
                        }
                    });
                }
                Ok(result) => {
                    send_result(
                        queue.clone(),
                        callback,
                        |cx| Ok(cx.boxed(Worker { sender })),
                    );
                    let core = Arc::new(result);
                    tracing_init();
                    loop {
                        // TODO: handle this error
                        let request = receiver.recv().await.unwrap();
                        let core = core.clone();
                        let queue = queue.clone();

                        match request {
                            Request::Shutdown { callback } => {
                                tokio::spawn(void_future_to_js(
                                    queue,
                                    callback,
                                    async move {
                                        core.shutdown().await;
                                        // Wrap the empty result in a valid Result object
                                        let result: Result<(), String> = Ok(());
                                        result
                                    },
                                    |cx, err| UNEXPECTED_ERROR.from_error(cx, err),
                                ));
                            }
                            Request::BreakLoop { callback } => {
                                send_result(queue, callback, |cx| Ok(cx.undefined()));
                                break;
                            }
                            Request::PollWorkflowActivation { callback } => {
                                tokio::spawn(handle_poll_workflow_activation_request(
                                    core, queue, callback,
                                ));
                            }
                            Request::PollActivityTask { callback } => {
                                tokio::spawn(handle_poll_activity_task_request(
                                    core, queue, callback,
                                ));
                            }
                            Request::CompleteWorkflowActivation {
                                completion,
                                callback,
                            } => {
                                tokio::spawn(void_future_to_js(
                                    queue,
                                    callback,
                                    async move { core.complete_workflow_task(completion).await },
                                    |cx, err| match err {
                                        CompleteWfError::WorkflowUpdateError { run_id, source } => {
                                            let args = vec![
                                                cx.string("Workflow update error").upcast(),
                                                cx.string(run_id).upcast(),
                                                cx.string(format!("{}", source)).upcast(),
                                            ];
                                            WORKFLOW_ERROR.construct(cx, args)
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
                                callback,
                            } => {
                                tokio::spawn(void_future_to_js(
                                    queue,
                                    callback,
                                    async move { core.complete_activity_task(completion).await },
                                    |cx, err| match err {
                                        CompleteActivityError::MalformedActivityCompletion {
                                            reason,
                                            ..
                                        } => Ok(JsError::type_error(cx, reason)?.upcast()),
                                        CompleteActivityError::TonicError(_) => {
                                            TRANSPORT_ERROR.from_error(cx, err)
                                        }
                                    },
                                ));
                            }
                            Request::RecordActivityHeartbeat {
                                heartbeat,
                                callback,
                            } => {
                                tokio::spawn(void_future_to_js(
                                    queue,
                                    callback,
                                    async move { core.record_activity_heartbeat(heartbeat).await },
                                    |cx, err| match err {
                                        ActivityHeartbeatError::ShuttingDown => {
                                            SHUTDOWN_ERROR.from_error(cx, err)
                                        }
                                        ActivityHeartbeatError::HeartbeatTimeoutNotSet
                                        | ActivityHeartbeatError::UnknownActivity => {
                                            ACTIVITY_HEARTBEAT_ERROR.from_error(cx, err)
                                        }
                                        ActivityHeartbeatError::InvalidHeartbeatTimeout => {
                                            Ok(JsError::type_error(cx, format!("{}", err))?
                                                .upcast())
                                        }
                                    },
                                ));
                            }
                        }
                    }
                }
            }
        })
}

/// Called within the poll loop thread, calls core and triggers JS callback with result
async fn handle_poll_workflow_activation_request(
    core: Arc<impl Core>,
    queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    match core.poll_workflow_task().await {
        Ok(task) => {
            send_result(queue, callback, move |cx| {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len as u32)?;
                cx.borrow_mut(&mut result, |data| {
                    let mut slice = data.as_mut_slice::<u8>();
                    if let Err(_) = task.encode(&mut slice) {
                        panic!("Failed to encode task")
                    };
                });
                Ok(result)
            });
        }
        Err(err) => {
            send_error(queue, callback, move |cx| match err {
                PollWfError::ShutDown => SHUTDOWN_ERROR.from_error(cx, err),
                PollWfError::AutocompleteError(CompleteWfError::WorkflowUpdateError {
                    run_id,
                    source,
                })
                | PollWfError::WorkflowUpdateError { run_id, source } => {
                    let args = vec![
                        cx.string("Workflow update error").upcast(),
                        cx.string(run_id).upcast(),
                        cx.string(format!("{}", source)).upcast(),
                    ];
                    WORKFLOW_ERROR.construct(cx, args)
                }
                PollWfError::BadPollResponseFromServer(_) => {
                    UNEXPECTED_ERROR.from_error(cx, "Bad poll response from server")
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
    core: Arc<impl Core>,
    queue: Arc<EventQueue>,
    callback: Root<JsFunction>,
) {
    match core.poll_activity_task().await {
        Ok(task) => {
            send_result(queue, callback, move |cx| {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len as u32)?;
                cx.borrow_mut(&mut result, |data| {
                    let mut slice = data.as_mut_slice::<u8>();
                    if let Err(_) = task.encode(&mut slice) {
                        panic!("Failed to encode task")
                    };
                });
                Ok(result)
            });
        }
        Err(err) => {
            send_error(queue, callback, |cx| match err {
                PollActivityError::ShutDown => SHUTDOWN_ERROR.from_error(cx, err),
                PollActivityError::TonicError(_) => TRANSPORT_ERROR.from_error(cx, err),
            });
        }
    }
}

// Below are functions exported to JS

/// Create a new worker asynchronously.
/// Immediately spawns a poller thread that will block on [Request]s
/// Worker is returned to JS using supplied callback
fn worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker_options = cx.argument::<JsObject>(0)?;
    let server_options = worker_options
        .get(&mut cx, "serverOptions")?
        .downcast_or_throw::<JsObject, FunctionContext>(&mut cx)?;
    let url = server_options
        .get(&mut cx, "url")?
        .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
        .value(&mut cx);
    let callback = cx.argument::<JsFunction>(1)?.root(&mut cx);

    let gateway_opts = ServerGatewayOptions {
        target_url: Url::parse(&url).unwrap(),
        namespace: server_options
            .get(&mut cx, "namespace")?
            .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
            .value(&mut cx),
        task_queue: worker_options
            .get(&mut cx, "taskQueue")?
            .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
            .value(&mut cx),
        identity: server_options
            .get(&mut cx, "identity")?
            .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
            .value(&mut cx),
        worker_binary_id: server_options
            .get(&mut cx, "workerBinaryId")?
            .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
            .value(&mut cx),
        long_poll_timeout: Duration::from_millis(
            server_options
                .get(&mut cx, "longPollTimeoutMs")?
                .downcast_or_throw::<JsNumber, FunctionContext>(&mut cx)?
                .value(&mut cx) as u64,
        ),
    };

    let max_outstanding_activities = worker_options
        .get(&mut cx, "maxConcurrentActivityExecutions")?
        .downcast_or_throw::<JsNumber, FunctionContext>(&mut cx)?
        .value(&mut cx) as usize;
    let max_outstanding_workflow_tasks = worker_options
        .get(&mut cx, "maxConcurrentWorkflowTaskExecutions")?
        .downcast_or_throw::<JsNumber, FunctionContext>(&mut cx)?
        .value(&mut cx) as usize;

    let queue = Arc::new(cx.queue());
    std::thread::spawn(move || {
        start_bridge_loop(
            CoreInitOptions {
                gateway_opts,
                evict_after_pending_cleared: true,
                max_outstanding_workflow_tasks,
                max_outstanding_activities,
            },
            queue,
            callback,
        )
    });

    Ok(cx.undefined())
}

/// Cause the bridge loop to break, freeing up the thread
fn worker_break_loop(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let request = Request::BreakLoop {
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.sender.blocking_send(request) {
        callback_with_error(&mut cx, callback, |cx| UNEXPECTED_ERROR.from_error(cx, err))?;
    };
    Ok(cx.undefined())
}

/// Initiate a single workflow activation poll request.
/// There should be only one concurrent poll request for this type.
fn worker_poll_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let request = Request::PollWorkflowActivation {
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.sender.blocking_send(request) {
        callback_with_error(&mut cx, callback, |cx| UNEXPECTED_ERROR.from_error(cx, err))?;
    }
    Ok(cx.undefined())
}

/// Initiate a single activity task poll request.
/// There should be only one concurrent poll request for this type.
fn worker_poll_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    let request = Request::PollActivityTask {
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.sender.blocking_send(request) {
        callback_with_error(&mut cx, callback, |cx| UNEXPECTED_ERROR.from_error(cx, err))?;
    }
    Ok(cx.undefined())
}

/// Submit a workflow activation completion to core.
fn worker_complete_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let completion = cx.argument::<JsArrayBuffer>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;
    let result = cx.borrow(&completion, |data| {
        WfActivationCompletion::decode_length_delimited(data.as_slice::<u8>())
    });
    match result {
        Ok(completion) => {
            let request = Request::CompleteWorkflowActivation {
                completion,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.sender.blocking_send(request) {
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
    let result = cx.argument::<JsArrayBuffer>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;
    let result = cx.borrow(&result, |data| {
        ActivityTaskCompletion::decode_length_delimited(data.as_slice::<u8>())
    });
    match result {
        Ok(completion) => {
            let request = Request::CompleteActivityTask {
                completion,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.sender.blocking_send(request) {
                callback_with_error(&mut cx, callback, |cx| UNEXPECTED_ERROR.from_error(cx, err))?;
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
    let callback = cx.argument::<JsFunction>(2)?;
    let heartbeat = cx.borrow(&heartbeat, |data| {
        ActivityHeartbeat::decode_length_delimited(data.as_slice::<u8>())
    });
    match heartbeat {
        Ok(heartbeat) => {
            let request = Request::RecordActivityHeartbeat {
                heartbeat,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = worker.sender.blocking_send(request) {
                callback_with_error(&mut cx, callback, |cx| UNEXPECTED_ERROR.from_error(cx, err))?;
            };
        }
        Err(_) => callback_with_error(&mut cx, callback, |cx| {
            JsError::type_error(cx, "Cannot decode ActivityHeartbeat from buffer")
        })?,
    };
    Ok(cx.undefined())
}

/// Request shutdown of the worker.
/// Once complete Core will stop polling on new tasks and activations.
/// Caller should drain any pending tasks and activations before breaking from
/// the loop to ensure graceful shutdown.
fn worker_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    match worker.sender.blocking_send(Request::Shutdown {
        callback: callback.root(&mut cx),
    }) {
        Err(err) => cx.throw_error(format!("{}", err)),
        _ => Ok(cx.undefined()),
    }
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("registerErrors", errors::register_errors)?;
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("workerShutdown", worker_shutdown)?;
    cx.export_function("workerBreakLoop", worker_break_loop)?;
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
