use crate::client::ClientHandle;
use crate::enter_sync;
use crate::future::BridgeFuture;
use crate::helpers::{
    AbortController, AbortSignal, BridgeError, BridgeResult, CustomJavaScriptErrors as _,
    IntoThrow as _, JsAsyncCallback, JsCallback, TryFromJs, TryIntoJs,
};
use crate::runtime::*;
use anyhow::Context as AnyhowContext;
use bridge_macros::{TryFromJs, TryIntoJs, js_function};
use neon::{context::Context, handle::Handle, prelude::*};
use prost::Message;
use std::marker::PhantomData;
use std::time::Duration;
use std::{cell::RefCell, sync::Arc};
use temporal_sdk_core::api::errors::{CompleteActivityError, CompleteWfError};
use temporal_sdk_core::api::worker::{
    ActivitySlotKind, LocalActivitySlotKind, PollerBehavior, SlotInfo as CoreSlotInfo,
    SlotInfoTrait as _, SlotKindType as CoreSlotKindType,
    SlotMarkUsedContext as CoreSlotMarkUsedContext, SlotReleaseContext as CoreSlotReleaseContext,
    SlotReservationContext as CoreSlotReservationContext, SlotSupplier as CoreSlotSupplier,
    SlotSupplierPermit as CoreSlotSupplierPermit, WorkflowSlotKind,
};
use temporal_sdk_core::api::worker::{SlotKind, WorkerConfigBuilderError};
use temporal_sdk_core::replay::{HistoryForReplay, ReplayWorkerInput};
use temporal_sdk_core::{
    ResourceBasedSlotsOptions, ResourceBasedSlotsOptionsBuilder, ResourceSlotOptions,
    SlotSupplierOptions as CoreSlotSupplierOptions, TunerHolderOptionsBuilder,
    api::worker::{WorkerConfig, WorkerConfigBuilder},
};
use temporal_sdk_core::{TunerHolder, init_replay_worker, init_worker};
use temporal_sdk_core::{
    Worker as CoreWorker,
    api::{Worker as CoreWorkerTrait, errors::PollError},
    protos::{
        coresdk::{
            ActivityHeartbeat, ActivityTaskCompletion,
            workflow_completion::WorkflowActivationCompletion,
        },
        temporal::api::history::v1::History,
    },
};
use tokio::sync::mpsc::{Sender, channel};
use tokio_stream::wrappers::ReceiverStream;

////////////////////////////////////////////////////////////////////////////////////////////////////
//
//

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on shutdown (requires mutability ^^^)
/// - WorkerHandle: The actual bridge worker handle (below)
pub type BoxedWorker = JsBox<RefCell<Option<WorkerHandle>>>;

#[derive(Clone)]
pub struct WorkerHandle {
    pub(crate) runtime_handle: RuntimeHandle,
    core_worker: RefCell<Option<Arc<CoreWorker>>>,
}

/// Box it so we can use Worker from JS
impl Finalize for WorkerHandle {}

impl TryFromJs for WorkerHandle {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let worker = js_value.downcast::<BoxedWorker, _>(cx)?;
        let worker = worker.borrow();
        Ok(worker
            .as_ref()
            .ok_or(BridgeError::IllegalStateAlreadyClosed { what: "Worker" })?
            .clone())
    }
}

impl TryIntoJs for WorkerHandle {
    type Output = BoxedWorker;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, BoxedWorker> {
        Ok(cx.boxed(RefCell::new(Some(self.clone()))))
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Create a new worker.
#[js_function]
pub fn worker_new(
    client: ClientHandle,
    worker_options: BridgeWorkerOptions,
) -> BridgeResult<WorkerHandle> {
    let worker_options = worker_options
        .into_core_config()
        .context("Failed to convert WorkerOptions to CoreWorkerConfig")?;

    let runtime_handle = client.runtime_handle.clone();
    enter_sync!(runtime_handle);

    let worker = init_worker(
        &runtime_handle.core_runtime,
        worker_options,
        client.core_client.clone(),
    )
    .context("Failed to initialize worker")?;

    Ok(WorkerHandle {
        runtime_handle: runtime_handle.clone(),
        core_worker: RefCell::new(Some(Arc::new(worker))),
    })
}

/// Validate a worker.
#[js_function]
pub fn worker_validate(worker: WorkerHandle) -> BridgeResult<BridgeFuture<()>> {
    let core_worker = worker.core_worker.borrow().clone().unwrap();
    let runtime_handle = worker.runtime_handle.clone();

    runtime_handle.clone().future_to_promise(async move {
        core_worker
            .validate()
            .await
            .map_err(|err| BridgeError::TransportError(err.to_string()))
    })
}

/// Initiate a single workflow activation poll request.
/// There should be only one concurrent poll request for this type.
#[js_function]
pub fn worker_poll_workflow_activation(
    worker: WorkerHandle,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let core_worker = worker.core_worker.borrow().clone().unwrap();
    let runtime_handle = worker.runtime_handle.clone();

    runtime_handle.clone().future_to_promise(async move {
        let result = core_worker.poll_workflow_activation().await;

        match result {
            Ok(task) => Ok(task.encode_to_vec()),
            Err(err) => match err {
                PollError::ShutDown => Err(BridgeError::WorkerShutdown)?,
                PollError::TonicError(status) => {
                    Err(BridgeError::TransportError(status.message().to_string()))?
                }
            },
        }
    })
}

/// Submit a workflow activation completion to core.
#[js_function]
pub fn worker_complete_workflow_activation(
    worker: WorkerHandle,
    completion: Vec<u8>,
) -> BridgeResult<BridgeFuture<()>> {
    let workflow_completion = WorkflowActivationCompletion::decode_length_delimited(
        completion.as_slice(),
    )
    .map_err(|err| BridgeError::TypeError {
        field: None,
        message: format!("Cannot decode Completion from buffer: {:?}", err),
    })?;

    let core_worker = worker.core_worker.borrow().clone().unwrap();
    let runtime_handle = worker.runtime_handle.clone();

    runtime_handle.clone().future_to_promise(async move {
        core_worker
            .complete_workflow_activation(workflow_completion)
            .await
            .map_err(|err| match err {
                CompleteWfError::MalformedWorkflowCompletion { reason, run_id } => {
                    BridgeError::TypeError {
                        field: None,
                        message: format!(
                            "Malformed Workflow Completion: {:?} for RunID={}",
                            reason, run_id
                        ),
                    }
                }
            })
    })
}

/// Initiate a single activity task poll request.
/// There should be only one concurrent poll request for this type.
#[js_function]
pub fn worker_poll_activity_task(worker: WorkerHandle) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let core_worker = worker.core_worker.borrow().clone().unwrap();
    let runtime_handle = worker.runtime_handle.clone();

    runtime_handle.clone().future_to_promise(async move {
        let result = core_worker.poll_activity_task().await;

        match result {
            Ok(task) => Ok(task.encode_to_vec()),
            Err(err) => match err {
                PollError::ShutDown => Err(BridgeError::WorkerShutdown)?,
                PollError::TonicError(status) => {
                    Err(BridgeError::TransportError(status.message().to_string()))?
                }
            },
        }
    })
}

/// Submit an activity task completion to core.
#[js_function]
pub fn worker_complete_activity_task(
    worker: WorkerHandle,
    completion: Vec<u8>,
) -> BridgeResult<BridgeFuture<()>> {
    let activity_completion =
        ActivityTaskCompletion::decode_length_delimited(completion.as_slice()).map_err(|err| {
            BridgeError::TypeError {
                field: None,
                message: format!("Cannot decode Completion from buffer: {:?}", err),
            }
        })?;

    let core_worker = worker.core_worker.borrow().clone().unwrap();
    let runtime_handle = worker.runtime_handle.clone();

    runtime_handle.clone().future_to_promise(async move {
        core_worker
            .complete_activity_task(activity_completion)
            .await
            .map_err(|err| match err {
                CompleteActivityError::MalformedActivityCompletion {
                    reason,
                    completion: _,
                } => BridgeError::TypeError {
                    field: None,
                    message: format!("Malformed Activity Completion: {:?}", reason),
                },
            })
    })
}

/// Submit an activity heartbeat to core.
#[js_function]
pub fn worker_record_activity_heartbeat(
    worker: WorkerHandle,
    heartbeat: Vec<u8>,
) -> BridgeResult<()> {
    let activity_heartbeat = ActivityHeartbeat::decode_length_delimited(heartbeat.as_slice())
        .map_err(|err| BridgeError::TypeError {
            field: None,
            message: format!("Cannot decode Heartbeat from buffer: {:?}", err),
        })?;

    worker
        .core_worker
        .borrow()
        .as_ref()
        .unwrap()
        .record_activity_heartbeat(activity_heartbeat);

    Ok(())
}

/// Request shutdown of the worker.
/// Once complete Core will stop polling on new tasks and activations on worker's task queue.
/// Caller should drain any pending tasks and activations and call worker_finalize_shutdown before breaking from
/// the loop to ensure graceful shutdown.
#[js_function]
pub fn worker_initiate_shutdown(worker: WorkerHandle) -> BridgeResult<()> {
    worker
        .core_worker
        .borrow()
        .as_ref()
        .unwrap()
        .initiate_shutdown();

    Ok(())
}

pub fn worker_finalize_shutdown(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let future = worker_finalize_shutdown_impl(worker).into_throw(&mut cx)?;
    future.try_into_js(&mut cx)
}

pub fn worker_finalize_shutdown_impl(
    worker: Handle<JsBox<RefCell<Option<WorkerHandle>>>>,
) -> BridgeResult<BridgeFuture<()>> {
    match worker.take() {
        None => Err(BridgeError::IllegalStateAlreadyClosed { what: "Worker" }),
        Some(worker_handle) => {
            let mut worker = worker_handle.core_worker.try_borrow_mut().map_err(|_| {
                BridgeError::IllegalStateStillInUse {
                    what: "Worker",
                    details: None,
                }
            })?;

            let worker = Arc::try_unwrap(worker.take().unwrap()).map_err(|arc| {
                BridgeError::IllegalStateStillInUse {
                    what: "Worker",
                    details: Some(format!(
                        "Expected 1 reference, but got {}",
                        Arc::strong_count(&arc)
                    )),
                }
            })?;

            worker_handle.runtime_handle.future_to_promise(async move {
                worker.finalize_shutdown().await;
                Ok(())
            })
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub type BoxedHistoryForReplayTunnel = JsBox<RefCell<Option<HistoryForReplayTunnelHandle>>>;

#[derive(Clone)]
pub(crate) struct HistoryForReplayTunnelHandle {
    pub(crate) runtime_handle: RuntimeHandle,
    sender: Sender<HistoryForReplay>,
}

impl TryFromJs for HistoryForReplayTunnelHandle {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let pusher = js_value.downcast::<BoxedHistoryForReplayTunnel, _>(cx)?;
        let pusher = pusher.borrow();
        Ok(pusher
            .as_ref()
            .ok_or(BridgeError::IllegalStateAlreadyClosed { what: "Pusher" })?
            .clone())
    }
}

impl TryIntoJs for HistoryForReplayTunnelHandle {
    type Output = BoxedHistoryForReplayTunnel;
    fn try_into_js<'a>(
        self,
        cx: &mut impl Context<'a>,
    ) -> JsResult<'a, BoxedHistoryForReplayTunnel> {
        Ok(cx.boxed(RefCell::new(Some(self.clone()))))
    }
}

impl HistoryForReplayTunnelHandle {
    fn new(runtime_handle: RuntimeHandle) -> (Self, ReceiverStream<HistoryForReplay>) {
        let (sender, rx) = channel(1);
        (
            HistoryForReplayTunnelHandle {
                runtime_handle,
                sender,
            },
            ReceiverStream::new(rx),
        )
    }

    pub fn get_chan(&self) -> Sender<HistoryForReplay> {
        self.sender.clone()
    }
}

impl Finalize for HistoryForReplayTunnelHandle {}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Result struct for replay worker creation
pub struct ReplayWorkerResult {
    pub worker: WorkerHandle,
    pub pusher: HistoryForReplayTunnelHandle,
}

impl TryIntoJs for ReplayWorkerResult {
    type Output = JsObject;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsObject> {
        let obj = cx.empty_object();
        let worker = self.worker.try_into_js(cx)?;
        let pusher = self.pusher.try_into_js(cx)?;
        obj.set(cx, "worker", worker)?;
        obj.set(cx, "pusher", pusher)?;
        Ok(obj)
    }
}

/// Create a new replay worker asynchronously.
#[js_function]
pub fn replay_worker_new(
    runtime: RuntimeHandle,
    worker_options: BridgeWorkerOptions,
) -> BridgeResult<ReplayWorkerResult> {
    let worker_options = worker_options
        .into_core_config()
        .context("Failed to convert WorkerOptions to CoreWorkerConfig")?;

    enter_sync!(runtime);

    let (tunnel, stream) = HistoryForReplayTunnelHandle::new(runtime.clone());

    let worker = init_replay_worker(ReplayWorkerInput::new(worker_options, Box::pin(stream)))
        .context("Failed to initialize replay worker")?;

    let worker_handle = WorkerHandle {
        runtime_handle: runtime.clone(),
        core_worker: RefCell::new(Some(Arc::new(worker))),
    };

    Ok(ReplayWorkerResult {
        worker: worker_handle,
        pusher: tunnel,
    })
}

#[js_function]
pub fn push_history(
    pusher: HistoryForReplayTunnelHandle,
    workflow_id: String,
    history_binary: Vec<u8>,
) -> BridgeResult<BridgeFuture<()>> {
    let history: History =
        History::decode_length_delimited(history_binary.as_slice()).map_err(|err| {
            BridgeError::TypeError {
                field: None,
                message: format!("Cannot decode History from buffer: {:?}", err),
            }
        })?;

    let runtime_handle = pusher.runtime_handle.clone();
    let chan = pusher.get_chan();
    let history = HistoryForReplay::new(history, workflow_id);

    runtime_handle.clone().future_to_promise(async move {
        chan.send(history)
            .await
            .context("Error pushing history to replay worker")?;
        Ok(())
    })
}

pub fn close_history_stream(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let pusher: Handle<BoxedHistoryForReplayTunnel> = cx.argument(0)?;
    match pusher.take() {
        Some(_) => Ok(cx.undefined()),
        None => cx.throw_illegal_state_error("Pusher has already been history"),
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

#[derive(TryFromJs)]
pub struct BridgeWorkerOptions {
    identity: String,
    build_id: String,
    use_versioning: bool,
    task_queue: String,
    namespace: String,
    tuner: WorkerTuner,
    non_sticky_to_sticky_poll_ratio: f32,
    max_concurrent_workflow_task_polls: usize,
    max_concurrent_activity_task_polls: usize,
    enable_non_local_activities: bool,
    sticky_queue_schedule_to_start_timeout: Duration,
    max_cached_workflows: usize,
    max_heartbeat_throttle_interval: Duration,
    default_heartbeat_throttle_interval: Duration,
    max_activities_per_second: Option<f64>,
    max_task_queue_activities_per_second: Option<f64>,
    shutdown_grace_time: Option<Duration>,
}

impl BridgeWorkerOptions {
    fn into_core_config(self) -> Result<WorkerConfig, WorkerConfigBuilderError> {
        // Set all other options
        let mut builder = WorkerConfigBuilder::default();
        builder
            .client_identity_override(Some(self.identity))
            .worker_build_id(self.build_id)
            .use_worker_versioning(self.use_versioning)
            .task_queue(self.task_queue)
            .namespace(self.namespace)
            .tuner(self.tuner.into_core_config()?)
            .nonsticky_to_sticky_poll_ratio(self.non_sticky_to_sticky_poll_ratio)
            .workflow_task_poller_behavior(PollerBehavior::SimpleMaximum(
                self.max_concurrent_workflow_task_polls,
            ))
            .activity_task_poller_behavior(PollerBehavior::SimpleMaximum(
                self.max_concurrent_activity_task_polls,
            ))
            .no_remote_activities(!self.enable_non_local_activities)
            .sticky_queue_schedule_to_start_timeout(self.sticky_queue_schedule_to_start_timeout)
            .max_cached_workflows(self.max_cached_workflows)
            .max_heartbeat_throttle_interval(self.max_heartbeat_throttle_interval)
            .default_heartbeat_throttle_interval(self.default_heartbeat_throttle_interval)
            .max_task_queue_activities_per_second(self.max_task_queue_activities_per_second)
            .max_worker_activities_per_second(self.max_activities_per_second)
            .graceful_shutdown_period(self.shutdown_grace_time)
            .build()
    }
}

#[derive(TryFromJs)]
pub struct WorkerTuner {
    workflow_task_slot_supplier: SlotSupplier<WorkflowSlotKind>,
    activity_task_slot_supplier: SlotSupplier<ActivitySlotKind>,
    local_activity_task_slot_supplier: SlotSupplier<LocalActivitySlotKind>,
}

impl WorkerTuner {
    fn into_core_config(self) -> Result<Arc<TunerHolder>, String> {
        let mut tuner_holder = TunerHolderOptionsBuilder::default();
        let mut rbo = None;

        tuner_holder.workflow_slot_options(
            self.workflow_task_slot_supplier
                .into_slot_supplier(&mut rbo)?,
        );
        tuner_holder.activity_slot_options(
            self.activity_task_slot_supplier
                .into_slot_supplier(&mut rbo)?,
        );
        tuner_holder.local_activity_slot_options(
            self.local_activity_task_slot_supplier
                .into_slot_supplier(&mut rbo)?,
        );
        if let Some(rbo) = rbo {
            tuner_holder.resource_based_options(rbo);
        }

        tuner_holder
            .build_tuner_holder()
            .map(Arc::new)
            .map_err(|e| format!("Invalid tuner options: {:?}", e))
    }
}

#[derive(TryFromJs)]
pub enum SlotSupplier<SK: SlotKind + Send + Sync + 'static> {
    FixedSize(FixedSizeSlotSupplierOptions),
    ResourceBased(ResourceBasedSlotSupplierOptions),
    Custom(CustomSlotSupplierOptions<SK>),
}

#[derive(TryFromJs)]
pub struct FixedSizeSlotSupplierOptions {
    num_slots: usize,
}

#[derive(TryFromJs)]
pub struct ResourceBasedSlotSupplierOptions {
    minimum_slots: usize,
    maximum_slots: usize,
    ramp_throttle: Duration,
    tuner_options: ResourceBasedTunerOptions,
}

#[derive(TryFromJs)]
pub struct ResourceBasedTunerOptions {
    target_memory_usage: f64,
    target_cpu_usage: f64,
}

impl<SK: SlotKind + Send + Sync + 'static> SlotSupplier<SK> {
    fn into_slot_supplier(
        self,
        rbo: &mut Option<ResourceBasedSlotsOptions>,
    ) -> Result<CoreSlotSupplierOptions<SK>, String> {
        match self {
            SlotSupplier::FixedSize(opts) => Ok(CoreSlotSupplierOptions::FixedSize {
                slots: opts.num_slots,
            }),
            SlotSupplier::ResourceBased(opts) => {
                *rbo = Some(
                    ResourceBasedSlotsOptionsBuilder::default()
                        .target_cpu_usage(opts.tuner_options.target_cpu_usage)
                        .target_mem_usage(opts.tuner_options.target_memory_usage)
                        .build()
                        .expect("Building ResourceBasedSlotsOptions can't fail"),
                );
                Ok(CoreSlotSupplierOptions::ResourceBased(
                    ResourceSlotOptions::new(
                        opts.minimum_slots,
                        opts.maximum_slots,
                        opts.ramp_throttle,
                    ),
                ))
            }
            SlotSupplier::Custom(opts) => Ok(CoreSlotSupplierOptions::Custom(Arc::new(
                SlotSupplierBridge::<SK> { options: opts },
            ))),
        }
    }
}

// Custom Slot Supplier ////////////////////////////////////////////////////////////////////////////

struct SlotSupplierBridge<SK: SlotKind + Send + Sync + 'static> {
    options: CustomSlotSupplierOptions<SK>,
}

#[async_trait::async_trait]
impl<SK: SlotKind + Send + Sync + 'static> CoreSlotSupplier for SlotSupplierBridge<SK> {
    type SlotKind = SK;

    async fn reserve_slot(&self, ctx: &dyn CoreSlotReservationContext) -> CoreSlotSupplierPermit {
        loop {
            let reserve_ctx = SlotReserveContext {
                slot_type: SK::kind().into(),
                task_queue: ctx.task_queue().to_string(),
                worker_identity: ctx.worker_identity().to_string(),
                worker_build_id: ctx.worker_build_id().to_string(),
                is_sticky: ctx.is_sticky(),
            };

            // FIXME: Do I need to do something special to ensure that
            // the controller does not get dropped early?
            let (_abort_controller, abort_signal) = AbortController::new();

            let permit_result = self
                .options
                .reserve_slot
                .call((reserve_ctx, abort_signal))
                .await;

            match permit_result {
                Ok(permit) => {
                    return CoreSlotSupplierPermit::with_user_data(BridgePermitData {
                        permit: Arc::new(permit),
                    });
                }
                Err(err) => {
                    log::warn!("Error reserving slot: {:?}", err);
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                    continue;
                }
            }
        }
    }

    fn try_reserve_slot(
        &self,
        ctx: &dyn CoreSlotReservationContext,
    ) -> Option<CoreSlotSupplierPermit> {
        let tokio_runtime = tokio::runtime::Handle::current();
        let _entered = tokio_runtime.enter();

        let reserve_ctx = SlotReserveContext {
            slot_type: SK::kind().into(),
            task_queue: ctx.task_queue().to_string(),
            worker_identity: ctx.worker_identity().to_string(),
            worker_build_id: ctx.worker_build_id().to_string(),
            is_sticky: ctx.is_sticky(),
        };

        // Try to reserve slot synchronously
        let result = self.options.try_reserve_slot.call_and_block((reserve_ctx,));

        match result {
            Ok(res) => res.map(|permit| {
                CoreSlotSupplierPermit::with_user_data(BridgePermitData {
                    permit: Arc::new(permit),
                })
            }),
            Err(err) => {
                log::warn!("Error reserving {} slot: {:?}", SK::kind(), err);
                None
            }
        }
    }

    fn mark_slot_used(&self, ctx: &dyn CoreSlotMarkUsedContext<SlotKind = Self::SlotKind>) {
        let tokio_runtime = tokio::runtime::Handle::current();
        let _entered = tokio_runtime.enter();

        let permit_data = ctx
            .permit()
            .user_data::<BridgePermitData>()
            .expect("Expected BridgePermitData in mark_slot_used");

        let slot_info = SlotInfo::from(&ctx.info().downcast());

        // Fire and forget call to mark_slot_used
        let _ = self
            .options
            .mark_slot_used
            .call_on_js_thread((SlotMarkUsedContext::<SK> {
                slot_info,
                permit: permit_data.permit.clone(),
                _marker: PhantomData,
            },));
    }

    fn release_slot(&self, ctx: &dyn CoreSlotReleaseContext<SlotKind = Self::SlotKind>) {
        let tokio_runtime = tokio::runtime::Handle::current();
        let _entered = tokio_runtime.enter();

        let permit_data = ctx
            .permit()
            .user_data::<BridgePermitData>()
            .expect("Expected BridgePermitData in release_slot");

        let slot_info = ctx.info().map(|info| SlotInfo::from(&info.downcast()));

        // Fire and forget call to release_slot
        let _ = self
            .options
            .release_slot
            .call_on_js_thread((SlotReleaseContext::<SK> {
                slot_info,
                permit: permit_data.permit.clone(),
                _marker: PhantomData,
            },));
    }
}

#[derive(TryFromJs)]
pub struct CustomSlotSupplierOptions<SK: SlotKind + Send + Sync + 'static> {
    reserve_slot: JsAsyncCallback<(SlotReserveContext, AbortSignal), SlotPermitOpaqueData>,
    try_reserve_slot: JsCallback<(SlotReserveContext,), Option<SlotPermitOpaqueData>>,
    mark_slot_used: JsCallback<(SlotMarkUsedContext<SK>,), ()>,
    release_slot: JsCallback<(SlotReleaseContext<SK>,), ()>,
}

impl<SK: SlotKind + Send + Sync + 'static> TryInto<CoreSlotSupplierOptions<SK>>
    for CustomSlotSupplierOptions<SK>
{
    type Error = BridgeError;

    fn try_into(self) -> Result<CoreSlotSupplierOptions<SK>, Self::Error> {
        Ok(CoreSlotSupplierOptions::Custom(Arc::new(
            SlotSupplierBridge { options: self },
        )))
    }
}

#[derive(TryIntoJs)]
enum SlotInfo {
    Workflow {
        workflow_type: String,
        is_sticky: bool,
    },
    Activity {
        activity_type: String,
    },
    LocalActivity {
        activity_type: String,
    },
    Nexus {
        service: String,
        operation: String,
    },
}

impl<'a> From<&'a CoreSlotInfo<'a>> for SlotInfo {
    fn from(info: &'a CoreSlotInfo<'a>) -> Self {
        match info {
            CoreSlotInfo::Workflow(info) => SlotInfo::Workflow {
                workflow_type: info.workflow_type.to_string(),
                is_sticky: info.is_sticky,
            },
            CoreSlotInfo::Activity(info) => SlotInfo::Activity {
                activity_type: info.activity_type.to_string(),
            },
            CoreSlotInfo::LocalActivity(info) => SlotInfo::LocalActivity {
                activity_type: info.activity_type.to_string(),
            },
            CoreSlotInfo::Nexus(info) => SlotInfo::Nexus {
                service: info.service.to_string(),
                operation: info.operation.to_string(),
            },
        }
    }
}

#[derive(TryIntoJs)]
struct SlotReserveContext {
    slot_type: SlotKindType,
    task_queue: String,
    worker_identity: String,
    worker_build_id: String,
    is_sticky: bool,
}

#[derive(TryIntoJs)]
struct SlotMarkUsedContext<SK: SlotKind> {
    slot_info: SlotInfo,
    permit: Arc<SlotPermitOpaqueData>,
    _marker: PhantomData<SK>,
}

#[derive(TryIntoJs)]
struct SlotReleaseContext<SK: SlotKind> {
    slot_info: Option<SlotInfo>,
    permit: Arc<SlotPermitOpaqueData>,
    _marker: PhantomData<SK>,
}

enum SlotKindType {
    Workflow,
    Activity,
    LocalActivity,
    Nexus,
}

// FIXME: Anyway we could get this auto-generated from CoreSlotKindType?
impl TryIntoJs for SlotKindType {
    type Output = JsString;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, JsString> {
        let s = match self {
            SlotKindType::Workflow => "workflow",
            SlotKindType::Activity => "activity",
            SlotKindType::LocalActivity => "local-activity",
            SlotKindType::Nexus => "nexus",
        };
        Ok(cx.string(s))
    }
}

impl From<CoreSlotKindType> for SlotKindType {
    fn from(val: CoreSlotKindType) -> Self {
        match val {
            CoreSlotKindType::Workflow => SlotKindType::Workflow,
            CoreSlotKindType::Activity => SlotKindType::Activity,
            CoreSlotKindType::LocalActivity => SlotKindType::LocalActivity,
            CoreSlotKindType::Nexus => SlotKindType::Nexus,
        }
    }
}

/// BridgePermitData holds the data associated with a slot permit.
struct BridgePermitData {
    permit: Arc<SlotPermitOpaqueData>,
}

/// An opaque handle to a root'd JS object.
///
/// Note that even though the public API allows `permit` to be any JS value, including
/// `undefined` or `null`, we may in fact only root JS _objects_ (including arrays and
/// functions, but not primitives). For that reason, we wrap the user's JS value in a
/// JSObject, and root that object instead.
struct SlotPermitOpaqueData(Root<JsObject>);

static PERMIT_DATA_FIELD: &str = "permit_data";

impl TryFromJs for SlotPermitOpaqueData {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let obj = cx.empty_object();
        obj.set(cx, PERMIT_DATA_FIELD, js_value)?;
        Ok(SlotPermitOpaqueData(obj.root(cx)))
    }
}

impl TryIntoJs for Arc<SlotPermitOpaqueData> {
    type Output = JsValue;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsValue> {
        let obj = self.as_ref().0.to_inner(cx);
        obj.get_value(cx, PERMIT_DATA_FIELD)
    }
}
