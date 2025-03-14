use crate::client::BoxedClientRef;
use crate::{conversions::*, enter_sync};
use crate::{errors::*, runtime::*};
use neon::types::buffer::TypedArray;
use neon::{
    context::Context,
    handle::Handle,
    prelude::*,
    types::{JsBoolean, JsNumber, JsString},
};
use prost::Message;
use slot_supplier_bridge::SlotSupplierBridge;
use std::cell::Cell;
use std::time::Duration;
use std::{cell::RefCell, sync::Arc};
use temporal_sdk_core::api::errors::{
    CompleteActivityError, CompleteWfError, WorkerValidationError,
};
use temporal_sdk_core::api::worker::SlotKind;
use temporal_sdk_core::replay::{HistoryForReplay, ReplayWorkerInput};
use temporal_sdk_core::{
    api::worker::{WorkerConfig, WorkerConfigBuilder},
    ResourceBasedSlotsOptions, ResourceBasedSlotsOptionsBuilder, ResourceSlotOptions,
    SlotSupplierOptions, TunerHolderOptionsBuilder,
};
use temporal_sdk_core::{
    api::{
        errors::{PollActivityError, PollWfError},
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
use temporal_sdk_core::{init_replay_worker, init_worker};
use tokio::sync::mpsc::{channel, Sender};
use tokio_stream::wrappers::ReceiverStream;

mod slot_supplier_bridge;

////////////////////////////////////////////////////////////////////////////////////////////////////
//
//

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on shutdown (requires mutability ^^^)
/// - Arc: So that we can safely pass the WorkerHandle around -- FIXME: Is this useful?
/// - WorkerHandle: The actual bridge worker handle (below)
pub type BoxedWorker = JsBox<RefCell<Option<WorkerHandle>>>;

#[derive(Clone)]
pub struct WorkerHandle {
    pub(crate) runtime_handle: Arc<RuntimeHandle>, // FIXME: Should we inline rather than Arc?
    pub(crate) core_worker: RefCell<Option<Arc<CoreWorker>>>,
}

/// Box it so we can use Worker from JS
impl Finalize for WorkerHandle {}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Create a new worker asynchronously.
pub fn worker_new(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let client: Handle<BoxedClientRef> = cx.argument(0)?;
    let client_ref = client.borrow();
    let client_handle = client_ref
        .as_ref()
        .expect("Tried to use Client after it has been closed");

    let worker_options = cx.argument::<JsObject>(1)?.as_worker_config(&mut cx)?;

    let runtime_handle = client_handle.runtime_handle.clone();
    enter_sync!(runtime_handle);

    match init_worker(
        &runtime_handle.core_runtime,
        worker_options,
        client_handle.core_client.clone(),
    ) {
        Ok(worker) => runtime_handle.clone().future_to_promise(
            &mut cx,
            async move {
                // FIXME: Other SDKs expose `valide` as a distinct lang call
                worker.validate().await?;

                Ok(WorkerHandle {
                    runtime_handle: runtime_handle.clone(),
                    core_worker: RefCell::new(Some(Arc::new(worker))),
                })
            },
            move |cx, result: anyhow::Result<WorkerHandle, WorkerValidationError>| match result {
                Ok(worker_handle) => Ok(cx.boxed(RefCell::new(Some(worker_handle)))),
                Err(err) => cx.throw_transport_error(format!("{:?}", err))?,
            },
        ),
        Err(err) => cx.throw_unexpected_error(format!("{:?}", err))?,
    }
}

/// Initiate a single workflow activation poll request.
/// There should be only one concurrent poll request for this type.
pub fn worker_poll_workflow_activation(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let worker: Handle<BoxedWorker> = cx.argument(0)?;
    let worker_ref = worker.borrow();
    let worker_handle = worker_ref
        .as_ref()
        .expect("Tried to use Worker after it has been shutdown");

    let core_worker = worker_handle.core_worker.borrow().clone().unwrap();

    worker_handle.runtime_handle.future_to_promise(
        &mut cx,
        async move { core_worker.poll_workflow_activation().await },
        |cx, result| match result {
            Ok(task) => {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len)?;
                let mut slice = result.as_mut_slice(cx);
                if let Err(err) = task.encode(&mut slice) {
                    cx.throw_unexpected_error(format!("Failed to encode task: {:?}", err))?;
                }
                Ok(result)
            }
            Err(err) => match err {
                PollWfError::ShutDown => cx.throw_shutdown_error(format!("{:?}", err)),
                PollWfError::TonicError(_) => cx.throw_transport_error(format!("{:?}", err)),
            },
        },
    )
}

/// Submit a workflow activation completion to core.
pub fn worker_complete_workflow_activation(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let worker: Handle<BoxedWorker> = cx.argument(0)?;
    let worker_ref = worker.borrow();
    let worker_handle = worker_ref
        .as_ref()
        .expect("Tried to use Worker after it has been shutdown");

    let completion: Handle<JsArrayBuffer> = cx.argument(1)?;
    let completion =
        WorkflowActivationCompletion::decode_length_delimited(completion.as_slice(&cx)).unwrap(); // FIXME: Handle error
                                                                                                  // (|_| cx.throw_type_error("Cannot decode Completion from buffer"))?;

    let core_worker = worker_handle.core_worker.borrow().clone().unwrap();

    worker_handle.runtime_handle.future_to_promise(
        &mut cx,
        async move { core_worker.complete_workflow_activation(completion).await },
        |cx, result| match result {
            Ok(()) => Ok(cx.undefined()),
            Err(CompleteWfError::MalformedWorkflowCompletion { reason, run_id }) => cx
                .throw_type_error(format!(
                    "Malformed Workflow Completion: {:?} for RunID={}",
                    reason, run_id
                )),
        },
    )
}

/// Initiate a single activity task poll request.
/// There should be only one concurrent poll request for this type.
pub fn worker_poll_activity_task(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let worker: Handle<BoxedWorker> = cx.argument(0)?;
    let worker_ref = worker.borrow();
    let worker_handle = worker_ref
        .as_ref()
        .expect("Tried to use Worker after it has been shutdown");

    let core_worker = worker_handle.core_worker.borrow().clone().unwrap();

    worker_handle.runtime_handle.future_to_promise(
        &mut cx,
        async move { core_worker.poll_activity_task().await },
        |cx, result| match result {
            Ok(task) => {
                let len = task.encoded_len();
                let mut result = JsArrayBuffer::new(cx, len)?;
                let mut slice = result.as_mut_slice(cx);
                if let Err(err) = task.encode(&mut slice) {
                    cx.throw_unexpected_error(format!("Failed to encode task: {:?}", err))?;
                }
                Ok(result)
            }
            Err(err) => match err {
                PollActivityError::ShutDown => cx.throw_shutdown_error("Worker has been shutdown"),
                PollActivityError::TonicError(status) => cx.throw_transport_error(status.message()),
            },
        },
    )
}

/// Submit an activity task completion to core.
pub fn worker_complete_activity_task(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let worker: Handle<BoxedWorker> = cx.argument(0)?;
    let worker_ref = worker.borrow();
    let worker_handle = worker_ref
        .as_ref()
        .expect("Tried to use Worker after it has been shutdown");

    let completion: Handle<JsArrayBuffer> = cx.argument(1)?;
    let completion =
        ActivityTaskCompletion::decode_length_delimited(completion.as_slice(&cx)).unwrap(); // FIXME: Handle error
                                                                                            // (|_| cx.throw_type_error("Cannot decode Completion from buffer"))?;

    let core_worker = worker_handle.core_worker.borrow().clone().unwrap();

    worker_handle.runtime_handle.future_to_promise(
        &mut cx,
        async move { core_worker.complete_activity_task(completion).await },
        |cx, result| match result {
            Ok(()) => Ok(cx.undefined()),
            Err(CompleteActivityError::MalformedActivityCompletion {
                reason,
                completion: _,
            }) => cx.throw_type_error(format!("Malformed Activity Completion: {:?}", reason)),
        },
    )
}

/// Submit an activity heartbeat to core.
pub fn worker_record_activity_heartbeat(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker: Handle<BoxedWorker> = cx.argument(0)?;
    let worker_ref = worker.borrow();
    let worker_handle = worker_ref
        .as_ref()
        .expect("Tried to use Worker after it has been shutdown");

    let heartbeat: Handle<JsArrayBuffer> = cx.argument(1)?;
    let heartbeat = ActivityHeartbeat::decode_length_delimited(heartbeat.as_slice(&cx)).unwrap(); // FIXME: Handle error
                                                                                                  // (|_| cx.throw_type_error("Cannot decode Completion from buffer"))?;

    let core_worker = worker_handle.core_worker.borrow().clone().unwrap();
    core_worker.record_activity_heartbeat(heartbeat);

    Ok(cx.undefined())
}

/// Request shutdown of the worker.
/// Once complete Core will stop polling on new tasks and activations on worker's task queue.
/// Caller should drain any pending tasks and activations and call worker_finalize_shutdown before breaking from
/// the loop to ensure graceful shutdown.
pub fn worker_initiate_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker: Handle<BoxedWorker> = cx.argument(0)?;
    let worker_ref = worker.borrow();
    let worker_handle = worker_ref
        .as_ref()
        .expect("Tried to use Worker after it has been shutdown");

    worker_handle
        .core_worker
        .borrow()
        .as_ref()
        .unwrap()
        .initiate_shutdown();

    Ok(cx.undefined())
}

pub fn worker_finalize_shutdown(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let worker: Handle<BoxedWorker> = cx.argument(0)?;

    match worker.take() {
        Some(worker_handle) => {
            let worker = worker_handle
                .core_worker
                .try_borrow_mut()
                .map_err(|_| "Worker still in use")
                .and_then(|mut val| {
                    Arc::try_unwrap(val.take().unwrap()).map_err(|_| "Expected 1 reference")
                })
                .expect("Some error");

            worker_handle.runtime_handle.future_to_promise(
                &mut cx,
                async move {
                    worker.finalize_shutdown().await;
                    Ok(())
                },
                move |cx, result: anyhow::Result<()>| match result {
                    Ok(client_handle) => Ok(cx.boxed(RefCell::new(Some(client_handle)))),
                    Err(err) => cx.throw_unexpected_error(format!(
                        "Failed to complete Worker shutdown: {:?}",
                        err
                    ))?,
                },
            )
        }
        None => cx.throw_illegal_state_error("Worker has already been shutdown"),
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub type BoxedHistoryForReplayTunnel = JsBox<RefCell<Option<HistoryForReplayTunnelHandle>>>;

pub(crate) struct HistoryForReplayTunnelHandle {
    pub(crate) runtime_handle: Arc<RuntimeHandle>, // FIXME: Should we inline rather than Arc?
    sender: Cell<Option<Sender<HistoryForReplay>>>,
}

impl HistoryForReplayTunnelHandle {
    fn new(runtime: Arc<RuntimeHandle>) -> (Self, ReceiverStream<HistoryForReplay>) {
        let (sender, rx) = channel(1);
        (
            HistoryForReplayTunnelHandle {
                runtime_handle: runtime,
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
impl Finalize for HistoryForReplayTunnelHandle {}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Create a new replay worker asynchronously.
pub fn replay_worker_new(mut cx: FunctionContext) -> JsResult<JsObject> {
    let runtime: Handle<BoxedRuntimeRef> = cx.argument(0)?;
    let runtime_ref = runtime.borrow();
    let runtime_handle = runtime_ref
        .as_ref()
        .expect("Tried to use Runtime after it has been shutdown")
        .clone();

    let worker_options = cx.argument::<JsObject>(1)?.as_worker_config(&mut cx)?;

    enter_sync!(runtime_handle);

    let (tunnel, stream) = HistoryForReplayTunnelHandle::new(runtime_handle.clone());

    match init_replay_worker(ReplayWorkerInput::new(worker_options, Box::pin(stream))) {
        Ok(worker) => {
            let worker_handle = WorkerHandle {
                runtime_handle: runtime_handle.clone(),
                core_worker: RefCell::new(Some(Arc::new(worker))),
            };

            let worker: Handle<BoxedWorker> = cx.boxed(RefCell::new(Some(worker_handle)));
            let tunnel: Handle<BoxedHistoryForReplayTunnel> = cx.boxed(RefCell::new(Some(tunnel)));
            let retme = cx.empty_object();
            retme.set(&mut cx, "worker", worker)?;
            retme.set(&mut cx, "pusher", tunnel)?;
            Ok(retme)
        }
        Err(err) => cx.throw_unexpected_error(format!("{:?}", err))?,
    }
}

pub fn push_history(mut cx: FunctionContext) -> JsResult<JsPromise> {
    println!("push_history 000");
    let _arg0: Handle<JsValue> = cx.argument(0)?;
    println!("push_history 001 -- {:?}", _arg0);

    let pusher: Handle<BoxedHistoryForReplayTunnel> = cx.argument(0)?;
    println!("push_history 006");
    let pusher_ref = pusher.borrow();
    println!("push_history 008");
    let pusher_handle = pusher_ref
        .as_ref()
        .expect("Tried to use Pusher after it has been closed");

    println!("push_history 010");

    let workflow_id = cx.argument::<JsString>(1)?;

    let history_binary = cx.argument::<JsArrayBuffer>(2)?;
    let history: History = History::decode_length_delimited(history_binary.as_slice(&cx)).unwrap();

    println!("push_history 020");

    let runtime_handle = pusher_handle.runtime_handle.clone();

    let workflow_id = workflow_id.value(&mut cx);
    match pusher_handle.get_chan() {
        Ok(chan) => {
            println!("push_history 100");
            let history = HistoryForReplay::new(history, workflow_id);

            runtime_handle.future_to_promise(
                &mut cx,
                async move {
                    println!("push_history 200");
                    let x = chan.send(history).await;
                    println!("push_history 201");
                    x
                },
                move |cx, result| {
                    println!("push_history 300");

                    match result {
                        Ok(()) => Ok(cx.undefined()),
                        Err(e) => cx.throw_unexpected_error(format!(
                            "Error pushing history to replay worker: {:?}",
                            e
                        ))?,
                    }
                },
            )
        }
        Err(e) => {
            println!("push_history 800");
            cx.throw_unexpected_error(e)?
        }
    }
}

pub fn close_history_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let pusher: Handle<BoxedHistoryForReplayTunnel> = cx.argument(0)?;
    match pusher.take() {
        Some(pusher) => {
            pusher.shutdown();
            Ok(cx.undefined())
        }
        None => cx.throw_illegal_state_error("Pusher has already been history"),
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

trait WorkerOptionsConversions {
    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig>;
    fn into_slot_supplier<SK: SlotKind + Send + Sync + 'static>(
        self,
        cx: &mut FunctionContext,
        rbo: &mut Option<ResourceBasedSlotsOptions>,
    ) -> NeonResult<SlotSupplierOptions<SK>>;
}

impl WorkerOptionsConversions for Handle<'_, JsObject> {
    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig> {
        let namespace = js_value_getter!(cx, self, "namespace", JsString);
        let task_queue = js_value_getter!(cx, self, "taskQueue", JsString);
        let enable_remote_activities =
            js_value_getter!(cx, self, "enableNonLocalActivities", JsBoolean);
        let max_concurrent_wft_polls =
            js_value_getter!(cx, self, "maxConcurrentWorkflowTaskPolls", JsNumber) as usize;
        let max_concurrent_at_polls =
            js_value_getter!(cx, self, "maxConcurrentActivityTaskPolls", JsNumber) as usize;
        let sticky_queue_schedule_to_start_timeout = Duration::from_millis(js_value_getter!(
            cx,
            self,
            "stickyQueueScheduleToStartTimeoutMs",
            JsNumber
        ) as u64);
        let max_cached_workflows =
            js_value_getter!(cx, self, "maxCachedWorkflows", JsNumber) as usize;

        let max_heartbeat_throttle_interval = Duration::from_millis(js_value_getter!(
            cx,
            self,
            "maxHeartbeatThrottleIntervalMs",
            JsNumber
        ) as u64);

        let default_heartbeat_throttle_interval = Duration::from_millis(js_value_getter!(
            cx,
            self,
            "defaultHeartbeatThrottleIntervalMs",
            JsNumber
        ) as u64);

        let max_worker_activities_per_second =
            js_optional_getter!(cx, self, "maxActivitiesPerSecond", JsNumber)
                .map(|num| num.value(cx));
        let max_task_queue_activities_per_second =
            js_optional_getter!(cx, self, "maxTaskQueueActivitiesPerSecond", JsNumber)
                .map(|num| num.value(cx));

        let graceful_shutdown_period =
            js_optional_getter!(cx, self, "shutdownGraceTimeMs", JsNumber)
                .map(|num| Duration::from_millis(num.value(cx) as u64));

        let nonsticky_to_sticky_poll_ratio =
            js_value_getter!(cx, self, "nonStickyToStickyPollRatio", JsNumber) as f32;

        let tuner = if let Some(tuner) = js_optional_getter!(cx, self, "tuner", JsObject) {
            let mut tuner_holder = TunerHolderOptionsBuilder::default();
            let mut rbo = None;

            if let Some(wf_slot_supp) =
                js_optional_getter!(cx, &tuner, "workflowTaskSlotSupplier", JsObject)
            {
                tuner_holder.workflow_slot_options(wf_slot_supp.into_slot_supplier(cx, &mut rbo)?);
            }
            if let Some(act_slot_supp) =
                js_optional_getter!(cx, &tuner, "activityTaskSlotSupplier", JsObject)
            {
                tuner_holder.activity_slot_options(act_slot_supp.into_slot_supplier(cx, &mut rbo)?);
            }
            if let Some(local_act_slot_supp) =
                js_optional_getter!(cx, &tuner, "localActivityTaskSlotSupplier", JsObject)
            {
                tuner_holder.local_activity_slot_options(
                    local_act_slot_supp.into_slot_supplier(cx, &mut rbo)?,
                );
            }
            if let Some(rbo) = rbo {
                tuner_holder.resource_based_options(rbo);
            }
            match tuner_holder.build_tuner_holder() {
                Err(e) => {
                    return cx.throw_error(format!("Invalid tuner options: {:?}", e));
                }
                Ok(th) => Arc::new(th),
            }
        } else {
            return cx.throw_error("Missing tuner");
        };

        match WorkerConfigBuilder::default()
            .worker_build_id(js_value_getter!(cx, self, "buildId", JsString))
            .client_identity_override(Some(js_value_getter!(cx, self, "identity", JsString)))
            .use_worker_versioning(js_value_getter!(cx, self, "useVersioning", JsBoolean))
            .no_remote_activities(!enable_remote_activities)
            .tuner(tuner)
            .max_concurrent_wft_polls(max_concurrent_wft_polls)
            .max_concurrent_at_polls(max_concurrent_at_polls)
            .nonsticky_to_sticky_poll_ratio(nonsticky_to_sticky_poll_ratio)
            .max_cached_workflows(max_cached_workflows)
            .sticky_queue_schedule_to_start_timeout(sticky_queue_schedule_to_start_timeout)
            .graceful_shutdown_period(graceful_shutdown_period)
            .namespace(namespace)
            .task_queue(task_queue)
            .max_heartbeat_throttle_interval(max_heartbeat_throttle_interval)
            .default_heartbeat_throttle_interval(default_heartbeat_throttle_interval)
            .max_worker_activities_per_second(max_worker_activities_per_second)
            .max_task_queue_activities_per_second(max_task_queue_activities_per_second)
            .build()
        {
            Ok(worker_cfg) => Ok(worker_cfg),
            Err(e) => cx.throw_error(format!("Invalid worker config: {:?}", e)),
        }
    }

    fn into_slot_supplier<SK: SlotKind + Send + Sync + 'static>(
        self,
        cx: &mut FunctionContext,
        rbo: &mut Option<ResourceBasedSlotsOptions>,
    ) -> NeonResult<SlotSupplierOptions<SK>> {
        match js_value_getter!(cx, &self, "type", JsString).as_str() {
            "fixed-size" => Ok(SlotSupplierOptions::FixedSize {
                slots: js_value_getter!(cx, &self, "numSlots", JsNumber) as usize,
            }),
            "resource-based" => {
                let min_slots = js_value_getter!(cx, &self, "minimumSlots", JsNumber);
                let max_slots = js_value_getter!(cx, &self, "maximumSlots", JsNumber);
                let ramp_throttle = js_value_getter!(cx, &self, "rampThrottleMs", JsNumber) as u64;
                if let Some(tuner_opts) = js_optional_getter!(cx, &self, "tunerOptions", JsObject) {
                    let target_mem =
                        js_value_getter!(cx, &tuner_opts, "targetMemoryUsage", JsNumber);
                    let target_cpu = js_value_getter!(cx, &tuner_opts, "targetCpuUsage", JsNumber);
                    *rbo = Some(
                        ResourceBasedSlotsOptionsBuilder::default()
                            .target_cpu_usage(target_cpu)
                            .target_mem_usage(target_mem)
                            .build()
                            .expect("Building ResourceBasedSlotsOptions can't fail"),
                    )
                } else {
                    return cx
                        .throw_type_error("Resource based slot supplier requires tunerOptions");
                };
                Ok(SlotSupplierOptions::ResourceBased(
                    ResourceSlotOptions::new(
                        min_slots as usize,
                        max_slots as usize,
                        Duration::from_millis(ramp_throttle),
                    ),
                ))
            }
            "custom" => {
                let ssb = SlotSupplierBridge::new(cx, self)?;
                Ok(SlotSupplierOptions::Custom(Arc::new(ssb)))
            }
            _ => cx.throw_type_error("Invalid slot supplier type"),
        }
    }
}
