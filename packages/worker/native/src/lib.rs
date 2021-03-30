use neon::{prelude::*, register_module};
use prost::Message;
use std::{sync::Arc, time::Duration};
use temporal_sdk_core::{
    init, protos::coresdk::workflow_completion::WfActivationCompletion,
    protos::coresdk::ActivityHeartbeat, protos::coresdk::ActivityTaskCompletion, Core,
    CoreInitOptions, ServerGatewayOptions, Url,
};
use tokio::sync::mpsc::{channel, Sender};

/// A request from JS to bridge to core
pub enum Request {
    /// A request to break from the thread loop sent from within the bridge when
    /// it encounters a CoreError::ShuttingDown
    /// TODO: this is odd, see if this should be sent from JS
    BreakPoller,
    /// A request to shutdown core, JS should wait on CoreError::ShuttingDown
    /// before exiting to allow draining of pending tasks
    Shutdown,
    /// A request to poll for workflow activations
    PollWorkflowActivation {
        /// Name of queue to poll
        queue_name: String,
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
        /// Name of queue to poll
        queue_name: String,
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
    SendActivityHeartbeat {
        heartbeat: ActivityHeartbeat,
        /// Used to send the result back into JS
        callback: Root<JsFunction>,
    },
}

/// Worker struct, hold a reference for the channel sender responsible for sending requests from
/// JS to core
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
fn send_error<T>(queue: Arc<EventQueue>, callback: Root<JsFunction>, error: T)
where
    T: ::std::fmt::Display + Send + 'static,
{
    queue.send(move |mut cx| {
        let callback = callback.into_inner(&mut cx);
        callback_with_error(&mut cx, callback, error)
    });
}

/// Call [callback] with given error
fn callback_with_error<'a, T>(
    cx: &mut impl Context<'a>,
    callback: Handle<JsFunction>,
    error: T,
) -> NeonResult<()>
where
    T: ::std::fmt::Display + Send + 'static,
{
    let this = cx.undefined();
    let error = JsError::error(cx, format!("{}", error))?;
    let result = cx.undefined();
    let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
    callback.call(cx, this, args)?;
    Ok(())
}

// Below are functions exported to JS

/// Create a new worker asynchronously.
/// Immediately spawns a poller thread that will block on [Request]s
/// Worker is returned to JS using supplied callback
fn worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let options = cx.argument::<JsObject>(0)?;
    let url = options
        .get(&mut cx, "url")?
        .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
        .value(&mut cx);
    let callback = cx.argument::<JsFunction>(1)?.root(&mut cx);

    let gateway_opts = ServerGatewayOptions {
        target_url: Url::parse(&url).unwrap(),
        namespace: options
            .get(&mut cx, "namespace")?
            .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
            .value(&mut cx),
        identity: options
            .get(&mut cx, "identity")?
            .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
            .value(&mut cx),
        worker_binary_id: options
            .get(&mut cx, "workerBinaryId")?
            .downcast_or_throw::<JsString, FunctionContext>(&mut cx)?
            .value(&mut cx),
        long_poll_timeout: Duration::from_millis(
            options
                .get(&mut cx, "longPollTimeoutMs")?
                .downcast_or_throw::<JsNumber, FunctionContext>(&mut cx)?
                .value(&mut cx) as u64,
        ),
    };
    // TODO: make this configurable
    let (sender, mut receiver) = channel::<Request>(1000);
    let worker = Worker {
        sender: sender.clone(),
    };
    let queue = Arc::new(cx.queue());

    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                match init(CoreInitOptions { gateway_opts }).await {
                    Ok(result) => {
                        send_result(queue.clone(), callback, |cx| Ok(cx.boxed(worker)));
                        let core = Arc::new(result);
                        loop {
                            // TODO: handle this error
                            let request = receiver.recv().await.unwrap();
                            if matches!(request, Request::BreakPoller) {
                                break;
                            } else if matches!(request, Request::Shutdown) {
                                core.shutdown();
                                continue;
                            }
                            let core = core.clone();
                            let queue = queue.clone();
                            let sender = sender.clone();
                            tokio::spawn(async move {
                                match request {
                                    Request::PollWorkflowActivation {
                                        queue_name,
                                        callback,
                                    } => {
                                        match core.poll_workflow_task(&queue_name).await {
                                            Ok(task) => {
                                                send_result(queue, callback, move |cx| {
                                                    let len = task.encoded_len();
                                                    let mut result =
                                                        JsArrayBuffer::new(cx, len as u32)?;
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
                                                // TODO: on the JS side we consider all errors fatal, revise this later
                                                if let temporal_sdk_core::CoreError::ShuttingDown =
                                                    err
                                                {
                                                    if let Err(_) =
                                                        sender.send(Request::BreakPoller).await
                                                    {
                                                        // TODO: handle error
                                                    }
                                                };
                                                send_error(queue, callback, err);
                                            }
                                        }
                                    }
                                    Request::PollActivityTask {
                                        queue_name,
                                        callback,
                                    } => {
                                        match core.poll_activity_task(&queue_name).await {
                                            Ok(task) => {
                                                send_result(queue, callback, move |cx| {
                                                    let len = task.encoded_len();
                                                    let mut result =
                                                        JsArrayBuffer::new(cx, len as u32)?;
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
                                                // TODO: on the JS side we consider all errors fatal, revise this later
                                                if let temporal_sdk_core::CoreError::ShuttingDown =
                                                    err
                                                {
                                                    if let Err(_) =
                                                        sender.send(Request::BreakPoller).await
                                                    {
                                                        // TODO: handle error
                                                    }
                                                };
                                                send_error(queue, callback, err);
                                            }
                                        }
                                    }
                                    Request::CompleteWorkflowActivation {
                                        completion,
                                        callback,
                                    } => match core.complete_workflow_task(completion).await {
                                        Ok(()) => {
                                            send_result(queue, callback, |cx| Ok(cx.undefined()));
                                        }
                                        Err(err) => {
                                            send_error(queue, callback, err);
                                        }
                                    },
                                    Request::CompleteActivityTask {
                                        completion,
                                        callback,
                                    } => match core.complete_activity_task(completion).await {
                                        Ok(()) => {
                                            send_result(queue, callback, |cx| Ok(cx.undefined()));
                                        }
                                        Err(err) => {
                                            send_error(queue, callback, err);
                                        }
                                    },
                                    Request::SendActivityHeartbeat {
                                        heartbeat,
                                        callback,
                                    } => match core.send_activity_heartbeat(heartbeat).await {
                                        Ok(()) => {
                                            send_result(queue, callback, |cx| Ok(cx.undefined()));
                                        }
                                        Err(err) => {
                                            send_error(queue, callback, err);
                                        }
                                    },
                                    // Ignore BreakPoller and Shutdown, they're handled above
                                    Request::BreakPoller => {}
                                    Request::Shutdown => {}
                                }
                            });
                        }
                    }
                    Err(err) => {
                        send_error(queue.clone(), callback, err);
                    }
                }
            })
    });

    Ok(cx.undefined())
}

/// Initiate a single workflow activation poll request.
/// There should be only one concurrent poll request for this type.
fn worker_poll_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let queue_name = cx.argument::<JsString>(1)?.value(&mut cx);
    let callback = cx.argument::<JsFunction>(2)?;
    let request = Request::PollWorkflowActivation {
        queue_name,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.sender.blocking_send(request) {
        callback_with_error(&mut cx, callback, err)?;
    }
    Ok(cx.undefined())
}

/// Initiate a single activity task poll request.
/// There should be only one concurrent poll request for this type.
fn worker_poll_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let queue_name = cx.argument::<JsString>(1)?.value(&mut cx);
    let callback = cx.argument::<JsFunction>(2)?;
    let request = Request::PollActivityTask {
        queue_name,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = worker.sender.blocking_send(request) {
        callback_with_error(&mut cx, callback, err)?;
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
                callback_with_error(&mut cx, callback, err)?;
            };
        }
        Err(_) => callback_with_error(&mut cx, callback, "Cannot decode Completion from buffer")?,
    };
    Ok(cx.undefined())
}

/// Submit a workflow activation completion to core.
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
                callback_with_error(&mut cx, callback, err)?;
            };
        }
        Err(_) => callback_with_error(&mut cx, callback, "Cannot decode Completion from buffer")?,
    };
    Ok(cx.undefined())
}

/// Request shutdown of the worker.
/// Caller should wait until a [CoreError::ShuttingDown] is returned from poll to ensure graceful
/// shutdown.
fn worker_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    match worker.sender.blocking_send(Request::Shutdown) {
        Err(err) => cx.throw_error(format!("{}", err)),
        _ => Ok(cx.undefined()),
    }
}

register_module!(mut cx, {
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("workerShutdown", worker_shutdown)?;
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
    Ok(())
});
