use crate::{conversions::ObjectHandleConversionsExt, errors::*, helpers::*, runtime::*};
use futures::stream::StreamExt;
use neon::{prelude::*, types::buffer::TypedArray};
use opentelemetry::trace::{FutureExt, SpanContext, TraceContextExt};
use prost::Message;
use std::{cell::RefCell, sync::Arc};
use temporal_sdk_core::replay::HistoryForReplay;
use temporal_sdk_core::{
    api::{
        errors::{CompleteActivityError, CompleteWfError, PollActivityError, PollWfError},
        Worker as CoreWorkerTrait,
    },
    protos::{
        coresdk::{
            workflow_completion::WorkflowActivationCompletion, ActivityHeartbeat,
            ActivityTaskCompletion,
        },
        temporal::api::history::v1::History,
    },
    Worker as CoreWorker,
};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio_stream::wrappers::UnboundedReceiverStream;

/// Worker struct, hold a reference for the channel sender responsible for sending requests from
/// JS to a bridge thread which forwards them to core
pub struct WorkerHandle {
    pub(crate) sender: UnboundedSender<WorkerRequest>,
}

/// Box it so we can use Worker from JS
pub type BoxedWorker = JsBox<RefCell<Option<WorkerHandle>>>;
impl Finalize for WorkerHandle {}

#[derive(Debug)]
pub enum WorkerRequest {
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

/// Polls on [WorkerRequest]s via given channel.
/// Bridges requests from JS to core and sends responses back to JS using a neon::Channel.
/// Returns when the given channel is dropped.
pub async fn start_worker_loop(
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
                            worker, otel_span, channel, callback,
                        )
                        .await
                    }
                    WorkerRequest::PollActivityTask {
                        otel_span,
                        callback,
                    } => {
                        handle_poll_activity_task_request(worker, otel_span, channel, callback)
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
                            |cx, err| -> JsResult<JsObject> {
                                match err {
                                    CompleteWfError::MalformedWorkflowCompletion {
                                        reason, ..
                                    } => Ok(JsError::type_error(cx, reason)?.upcast()),
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
                            |cx, err| -> JsResult<JsObject> {
                                match err {
                                    CompleteActivityError::MalformedActivityCompletion {
                                        reason,
                                        ..
                                    } => Ok(JsError::type_error(cx, reason)?.upcast()),
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
                PollWfError::ShutDown => make_named_error_from_error(cx, SHUTDOWN_ERROR, err),
                PollWfError::TonicError(_) => make_named_error_from_error(cx, TRANSPORT_ERROR, err),
                PollWfError::AutocompleteError(CompleteWfError::MalformedWorkflowCompletion {
                    reason,
                    ..
                }) => Ok(JsError::type_error(cx, reason)?),
            });
        }
    }
}

/// Called within the poll loop thread, calls core and triggers JS callback with result
pub async fn handle_poll_activity_task_request(
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
                PollActivityError::ShutDown => make_named_error_from_error(cx, SHUTDOWN_ERROR, err),
                PollActivityError::TonicError(_) => {
                    make_named_error_from_error(cx, TRANSPORT_ERROR, err)
                }
            });
        }
    }
}

// Below are functions exported to JS

/// Create a new worker asynchronously.
/// Worker uses the provided connection and returned to JS using supplied `callback`.
pub fn worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let worker_options = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let config = worker_options.as_worker_config(&mut cx)?;
    match client.borrow().as_ref() {
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
pub fn replay_worker_new(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let worker_options = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    let config = worker_options.as_worker_config(&mut cx)?;
    let request = RuntimeRequest::InitReplayWorker {
        runtime: (*runtime).clone(),
        config,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };

    Ok(cx.undefined())
}

pub fn push_history(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let pusher = cx.argument::<JsBox<HistoryForReplayTunnel>>(0)?;
    let workflow_id = cx.argument::<JsString>(1)?;
    let history_binary = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;
    let data = history_binary.as_slice(&cx);
    match History::decode_length_delimited(data) {
        Ok(hist) => {
            let workflow_id = workflow_id.value(&mut cx);
            if let Err(e) = pusher.get_chan().map(|chan| {
                pusher
                    .runtime
                    .sender
                    .send(RuntimeRequest::PushReplayHistory {
                        tx: chan,
                        pushme: HistoryForReplay::new(hist, workflow_id),
                        callback: callback.root(&mut cx),
                    })
            }) {
                callback_with_unexpected_error(&mut cx, callback, e)?;
            }
            Ok(cx.undefined())
        }
        Err(e) => cx.throw_error(format!("Error decoding history: {:?}", e)),
    }
}

pub fn close_history_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let pusher = cx.argument::<JsBox<HistoryForReplayTunnel>>(0)?;
    pusher.shutdown();
    Ok(cx.undefined())
}

/// Initiate a single workflow activation poll request.
/// There should be only one concurrent poll request for this type.
pub fn worker_poll_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;
    match worker.borrow().as_ref() {
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
pub fn worker_poll_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;
    match worker.borrow().as_ref() {
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
pub fn worker_complete_workflow_activation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let completion = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;
    match worker.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            match WorkflowActivationCompletion::decode_length_delimited(completion.as_slice(&cx)) {
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
pub fn worker_complete_activity_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let otel_span = cx.argument::<JsObject>(1)?;
    let result = cx.argument::<JsArrayBuffer>(2)?;
    let callback = cx.argument::<JsFunction>(3)?;
    match worker.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            match ActivityTaskCompletion::decode_length_delimited(result.as_slice(&cx)) {
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
pub fn worker_record_activity_heartbeat(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let heartbeat = cx.argument::<JsArrayBuffer>(1)?;
    match worker.borrow().as_ref() {
        None => {
            make_named_error_from_string(&mut cx, UNEXPECTED_ERROR, "Tried to use closed Worker")
                .and_then(|err| cx.throw(err))?
        }
        Some(worker) => match ActivityHeartbeat::decode_length_delimited(heartbeat.as_slice(&cx)) {
            Ok(heartbeat) => {
                let request = WorkerRequest::RecordActivityHeartbeat { heartbeat };
                if let Err(err) = worker.sender.send(request) {
                    make_named_error_from_error(&mut cx, UNEXPECTED_ERROR, err)
                        .and_then(|err| cx.throw(err))?;
                }
            }
            Err(_) => cx.throw_type_error("Cannot decode ActivityHeartbeat from buffer")?,
        },
    };
    Ok(cx.undefined())
}

/// Request shutdown of the worker.
/// Once complete Core will stop polling on new tasks and activations on worker's task queue.
/// Caller should drain any pending tasks and activations and call worker_finalize_shutdown before breaking from
/// the loop to ensure graceful shutdown.
pub fn worker_initiate_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    match worker.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Worker")?;
        }
        Some(worker) => {
            if let Err(err) = worker.sender.send(WorkerRequest::InitiateShutdown {
                callback: callback.root(&mut cx),
            }) {
                make_named_error_from_error(&mut cx, UNEXPECTED_ERROR, err)
                    .and_then(|err| cx.throw(err))?;
            };
        }
    }
    Ok(cx.undefined())
}

pub fn worker_finalize_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    if worker.replace(None).is_none() {
        make_named_error_from_string(&mut cx, ILLEGAL_STATE_ERROR, "Worker already closed")
            .and_then(|err| cx.throw(err))?;
    }

    Ok(cx.undefined())
}
