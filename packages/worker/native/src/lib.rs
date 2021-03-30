use neon::{prelude::*, register_module};
use prost::Message;
use std::{sync::Arc, time::Duration};
use temporal_sdk_core::{
    init, protos::coresdk::activity_result::ActivityResult,
    protos::coresdk::workflow_activation::WfActivation,
    protos::coresdk::workflow_completion::WfActivationCompletion, Core, CoreInitOptions,
    ServerGatewayOptions, Url,
};
use tokio::sync::mpsc::{channel, Sender};

/// A request from lang to bridge to core
pub enum Request {
    /// A request sent from within the bridge when it encounters a CoreError::ShuttingDown
    ShutdownComplete,
    /// A request to shutdown core and the bridge thread, lang should wait on
    /// CoreError::ShuttingDown before exiting to allow draining of pending tasks
    Shutdown,
    /// A request to poll for workflow activations
    PollWorkflowActivation {
        /// Name of queue to poll
        queue_name: String,
        /// Used to send the result back into lang
        callback: Root<JsFunction>,
    },
    /// A request to complete a single workflow activation
    CompleteWorkflowActivation {
        completion: WfActivationCompletion,
        /// Used to send the result back into lang
        callback: Root<JsFunction>,
    },
    /// A request to poll for activity tasks
    PollActivityTask {
        /// Name of queue to poll
        queue_name: String,
        /// Used to send the result back into lang
        callback: Root<JsFunction>,
    },
}

/// Worker struct, hold a reference for the channel sender responsible for sending requests from
/// lang to core
pub struct Worker {
    sender: Sender<Request>,
}

/// Box it so we can use Worker from JS
// TODO: we might not need Arc
type BoxedWorker = JsBox<Arc<Worker>>;

impl Finalize for Worker {}

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
    let worker = Arc::new(Worker {
        sender: sender.clone(),
    });
    let queue = Arc::new(cx.queue());
    let cloned_worker = Arc::clone(&worker);

    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                match init(CoreInitOptions { gateway_opts }).await {
                    Ok(result) => {
                        queue.clone().send(move |mut cx| {
                            let callback = callback.into_inner(&mut cx);
                            let this = cx.undefined();
                            let error = cx.undefined();
                            let result = cx.boxed(cloned_worker);
                            let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                            callback.call(&mut cx, this, args)?;
                            Ok(())
                        });
                        let core = Arc::new(result);
                        loop {
                            // TODO: handle this error
                            let request = receiver.recv().await.unwrap();
                            if matches!(request, Request::ShutdownComplete) {
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
                                                queue.send(move |mut cx| {
                                                    let callback = callback.into_inner(&mut cx);
                                                    let this = cx.undefined();
                                                    let error = cx.undefined();
                                                    let len = task.encoded_len();
                                                    let mut result =
                                                        JsArrayBuffer::new(&mut cx, len as u32)?;
                                                    cx.borrow_mut(&mut result, |data| {
                                                        let mut slice = data.as_mut_slice::<u8>();
                                                        if let Err(_) = task.encode(&mut slice) {
                                                            panic!("Failed to encode task")
                                                        };
                                                    });
                                                    let args: Vec<Handle<JsValue>> =
                                                        vec![error.upcast(), result.upcast()];
                                                    callback.call(&mut cx, this, args)?;
                                                    Ok(())
                                                });
                                            }
                                            Err(err) => {
                                                // TODO: on the JS side we consider all errors fatal, revise this later
                                                if let temporal_sdk_core::CoreError::ShuttingDown =
                                                    err
                                                {
                                                    if let Err(_) =
                                                        sender.send(Request::ShutdownComplete).await
                                                    {
                                                        // TODO: handle error
                                                    }
                                                };
                                                queue.send(move |mut cx| {
                                                    let callback = callback.into_inner(&mut cx);
                                                    let this = cx.undefined();
                                                    let error = JsError::error(
                                                        &mut cx,
                                                        format!("{}", err),
                                                    )?;
                                                    let result = cx.undefined();
                                                    let args: Vec<Handle<JsValue>> =
                                                        vec![error.upcast(), result.upcast()];
                                                    callback.call(&mut cx, this, args)?;
                                                    Ok(())
                                                });
                                            }
                                        }
                                    }
                                    Request::CompleteWorkflowActivation {
                                        completion,
                                        callback,
                                    } => {
                                        match core.complete_workflow_task(completion).await {
                                            Ok(()) => {
                                                queue.send(move |mut cx| {
                                                    let callback = callback.into_inner(&mut cx);
                                                    let this = cx.undefined();
                                                    let error = cx.undefined();
                                                    let result = cx.undefined();
                                                    let args: Vec<Handle<JsValue>> =
                                                        vec![error.upcast(), result.upcast()];
                                                    callback.call(&mut cx, this, args)?;
                                                    Ok(())
                                                });
                                            }
                                            Err(err) => {
                                                // TODO: on the JS side we consider all errors fatal, revise this later
                                                if let temporal_sdk_core::CoreError::ShuttingDown =
                                                    err
                                                {
                                                    if let Err(_) =
                                                        sender.send(Request::ShutdownComplete).await
                                                    {
                                                        // TODO: handle error
                                                    }
                                                };
                                                queue.send(move |mut cx| {
                                                    let callback = callback.into_inner(&mut cx);
                                                    let this = cx.undefined();
                                                    let error = JsError::error(
                                                        &mut cx,
                                                        format!("{}", err),
                                                    )?;
                                                    let result = cx.undefined();
                                                    let args: Vec<Handle<JsValue>> =
                                                        vec![error.upcast(), result.upcast()];
                                                    callback.call(&mut cx, this, args)?;
                                                    Ok(())
                                                });
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            });
                        }
                    }
                    Err(err) => {
                        let queue = queue.clone();
                        queue.send(move |mut cx| {
                            let callback = callback.into_inner(&mut cx);
                            let this = cx.undefined();
                            let error = JsError::error(&mut cx, format!("{}", err))?;
                            let result = cx.undefined();
                            let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                            callback.call(&mut cx, this, args)?;
                            Ok(())
                        });
                    }
                }
            })
    });

    Ok(cx.undefined())
}

/// Initiate a single poll request.
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
        let this = cx.undefined();
        let error = JsError::error(&mut cx, format!("{}", err))?;
        let result = cx.undefined();
        let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
        callback.call(&mut cx, this, args)?;
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
                let this = cx.undefined();
                let error = JsError::error(&mut cx, format!("{}", err))?;
                let result = cx.undefined();
                let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                callback.call(&mut cx, this, args)?;
            };
            Ok(cx.undefined())
        }
        Err(_) => cx.throw_type_error("Cannot decode Completion from buffer"),
    }
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
    cx.export_function(
        "workerCompleteWorkflowActivation",
        worker_complete_workflow_activation,
    )?;
    Ok(())
});
