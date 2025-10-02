use std::sync::Arc;

use anyhow::Context as AnyhowContext;
use neon::prelude::*;
use prost::Message;
use tokio::sync::mpsc::{Sender, channel};
use tokio_stream::wrappers::ReceiverStream;

use temporal_sdk_core::{
    CoreRuntime,
    api::{
        Worker as CoreWorkerTrait,
        errors::{CompleteActivityError, CompleteNexusError, CompleteWfError, PollError},
    },
    init_replay_worker, init_worker,
    protos::{
        coresdk::{
            ActivityHeartbeat, ActivityTaskCompletion, nexus::NexusTaskCompletion,
            workflow_completion::WorkflowActivationCompletion,
        },
        temporal::api::history::v1::History,
    },
    replay::{HistoryForReplay, ReplayWorkerInput},
};

use bridge_macros::js_function;

use crate::{
    client::Client,
    enter_sync,
    helpers::{handles::MutableFinalize, *},
    runtime::{Runtime, RuntimeExt},
};

pub fn init(cx: &mut ModuleContext) -> NeonResult<()> {
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("workerValidate", worker_validate)?;

    cx.export_function(
        "workerPollWorkflowActivation",
        worker_poll_workflow_activation,
    )?;
    cx.export_function(
        "workerCompleteWorkflowActivation",
        worker_complete_workflow_activation,
    )?;

    cx.export_function("workerPollActivityTask", worker_poll_activity_task)?;
    cx.export_function("workerCompleteActivityTask", worker_complete_activity_task)?;
    cx.export_function(
        "workerRecordActivityHeartbeat",
        worker_record_activity_heartbeat,
    )?;

    cx.export_function("workerPollNexusTask", worker_poll_nexus_task)?;
    cx.export_function("workerCompleteNexusTask", worker_complete_nexus_task)?;

    cx.export_function("workerInitiateShutdown", worker_initiate_shutdown)?;
    cx.export_function("workerFinalizeShutdown", worker_finalize_shutdown)?;

    // Replay worker functions
    cx.export_function("newReplayWorker", replay_worker_new)?;
    cx.export_function("pushHistory", push_history)?;
    cx.export_function("closeHistoryStream", close_history_stream)?;

    Ok(())
}

pub struct Worker {
    core_runtime: Arc<CoreRuntime>,

    // Arc so that we can send reference into async closures
    core_worker: Arc<temporal_sdk_core::Worker>,
}

/// Create a new worker.
#[js_function]
pub fn worker_new(
    client: OpaqueInboundHandle<Client>,
    worker_options: config::BridgeWorkerOptions,
) -> BridgeResult<OpaqueOutboundHandle<Worker>> {
    let config = worker_options
        .into_core_config()
        .context("Failed to convert WorkerOptions to CoreWorkerConfig")?;

    let client_ref = client.borrow()?;
    let client = client_ref.core_client.clone();
    let runtime = client_ref.core_runtime.clone();

    enter_sync!(runtime);
    let worker = init_worker(&runtime, config, client).context("Failed to initialize worker")?;

    Ok(OpaqueOutboundHandle::new(Worker {
        core_runtime: runtime,
        core_worker: Arc::new(worker),
    }))
}

/// Validate a worker.
#[js_function]
pub fn worker_validate(worker: OpaqueInboundHandle<Worker>) -> BridgeResult<BridgeFuture<()>> {
    let worker_ref = worker.borrow()?;
    let worker = worker_ref.core_worker.clone();
    let runtime = worker_ref.core_runtime.clone();

    runtime.future_to_promise(async move {
        worker
            .validate()
            .await
            .map_err(|err| BridgeError::TransportError(err.to_string()))
    })
}

/// Initiate a single workflow activation poll request.
/// There should be only one concurrent poll request for this type.
#[js_function]
pub fn worker_poll_workflow_activation(
    worker: OpaqueInboundHandle<Worker>,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let worker_ref = worker.borrow()?;
    let worker = worker_ref.core_worker.clone();
    let runtime = worker_ref.core_runtime.clone();

    runtime.future_to_promise(async move {
        let result = worker.poll_workflow_activation().await;

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
    worker: OpaqueInboundHandle<Worker>,
    completion: Vec<u8>,
) -> BridgeResult<BridgeFuture<()>> {
    let workflow_completion = WorkflowActivationCompletion::decode_length_delimited(
        completion.as_slice(),
    )
    .map_err(|err| BridgeError::TypeError {
        field: None,
        message: format!("Cannot decode Completion from buffer: {err:?}"),
    })?;

    let worker_ref = worker.borrow()?;
    let worker = worker_ref.core_worker.clone();
    let runtime = worker_ref.core_runtime.clone();

    runtime.future_to_promise(async move {
        worker
            .complete_workflow_activation(workflow_completion)
            .await
            .map_err(|err| match err {
                CompleteWfError::MalformedWorkflowCompletion { reason, run_id } => {
                    BridgeError::TypeError {
                        field: None,
                        message: format!(
                            "Malformed Workflow Completion: {reason:?} for RunID={run_id}"
                        ),
                    }
                }
            })
    })
}

/// Initiate a single activity task poll request.
/// There should be only one concurrent poll request for this type.
#[js_function]
pub fn worker_poll_activity_task(
    worker: OpaqueInboundHandle<Worker>,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let worker_ref = worker.borrow()?;
    let worker = worker_ref.core_worker.clone();
    let runtime = worker_ref.core_runtime.clone();

    runtime.future_to_promise(async move {
        let result = worker.poll_activity_task().await;

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
    worker: OpaqueInboundHandle<Worker>,
    completion: Vec<u8>,
) -> BridgeResult<BridgeFuture<()>> {
    let activity_completion =
        ActivityTaskCompletion::decode_length_delimited(completion.as_slice()).map_err(|err| {
            BridgeError::TypeError {
                field: None,
                message: format!("Cannot decode Completion from buffer: {err:?}"),
            }
        })?;

    let worker_ref = worker.borrow()?;
    let worker = worker_ref.core_worker.clone();
    let runtime = worker_ref.core_runtime.clone();

    runtime.future_to_promise(async move {
        worker
            .complete_activity_task(activity_completion)
            .await
            .map_err(|err| match err {
                CompleteActivityError::MalformedActivityCompletion {
                    reason,
                    completion: _,
                } => BridgeError::TypeError {
                    field: None,
                    message: format!("Malformed Activity Completion: {reason:?}"),
                },
            })
    })
}

/// Submit an activity heartbeat to core.
#[js_function]
pub fn worker_record_activity_heartbeat(
    worker: OpaqueInboundHandle<Worker>,
    heartbeat: Vec<u8>,
) -> BridgeResult<()> {
    let activity_heartbeat = ActivityHeartbeat::decode_length_delimited(heartbeat.as_slice())
        .map_err(|err| BridgeError::TypeError {
            field: None,
            message: format!("Cannot decode Heartbeat from buffer: {err:?}"),
        })?;

    let worker_ref = worker.borrow()?;
    worker_ref
        .core_worker
        .record_activity_heartbeat(activity_heartbeat);

    Ok(())
}

/// Initiate a single nexus task poll request.
/// There should be only one concurrent poll request for this type.
#[js_function]
pub fn worker_poll_nexus_task(
    worker: OpaqueInboundHandle<Worker>,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let worker_ref = worker.borrow()?;
    let worker = worker_ref.core_worker.clone();
    let runtime = worker_ref.core_runtime.clone();

    runtime.future_to_promise(async move {
        let result = worker.poll_nexus_task().await;

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

/// Submit an nexus task completion to core.
#[js_function]
pub fn worker_complete_nexus_task(
    worker: OpaqueInboundHandle<Worker>,
    completion: Vec<u8>,
) -> BridgeResult<BridgeFuture<()>> {
    let nexus_completion = NexusTaskCompletion::decode_length_delimited(completion.as_slice())
        .map_err(|err| BridgeError::TypeError {
            field: None,
            message: format!("Cannot decode Completion from buffer: {err:?}"),
        })?;

    let worker_ref = worker.borrow()?;
    let worker = worker_ref.core_worker.clone();
    let runtime = worker_ref.core_runtime.clone();

    runtime.future_to_promise(async move {
        worker
            .complete_nexus_task(nexus_completion)
            .await
            .map_err(|err| match err {
                CompleteNexusError::NexusNotEnabled {} => {
                    BridgeError::UnexpectedError(format!("{err}"))
                }
                CompleteNexusError::MalformedNexusCompletion { reason } => BridgeError::TypeError {
                    field: None,
                    message: format!("Malformed nexus Completion: {reason:?}"),
                },
            })
    })
}

/// Request shutdown of the worker.
/// Once complete Core will stop polling on new tasks and activations on worker's task queue.
/// Caller should drain any pending tasks and activations and call worker_finalize_shutdown before breaking from
/// the loop to ensure graceful shutdown.
#[js_function]
pub fn worker_initiate_shutdown(worker: OpaqueInboundHandle<Worker>) -> BridgeResult<()> {
    let worker_ref = worker.borrow()?;
    worker_ref.core_worker.initiate_shutdown();
    Ok(())
}

#[js_function]
pub fn worker_finalize_shutdown(
    worker: OpaqueInboundHandle<Worker>,
) -> BridgeResult<BridgeFuture<()>> {
    let worker_ref = worker.take()?;

    // We make supplementary copies of this arc in `worker_poll_*_task`, `worker_complete_*_task`, and
    // similar functions. Lang is responsible to ensure that there is no outstanding calls to these
    // functions by the time `finalize_shutdown` is called, in which case unwrapping the arc here is ok.
    let worker = Arc::try_unwrap(worker_ref.core_worker).map_err(|arc| {
        BridgeError::IllegalStateStillInUse {
            what: "Worker",
            details: Some(format!(
                "Expected 1 reference, but got {}",
                Arc::strong_count(&arc)
            )),
        }
    })?;

    worker_ref.core_runtime.future_to_promise(async move {
        worker.finalize_shutdown().await;
        Ok(())
    })
}

impl MutableFinalize for Worker {
    fn finalize_mut(self) {
        self.core_runtime.spawn_and_forget(async move {
            // We make supplementary copies of this arc in `worker_poll_*_task`, `worker_complete_*_task`, and
            // similar functions. Lang is responsible to ensure that there is no outstanding calls to these
            // functions by the time `finalize_shutdown` is called, in which case unwrapping the arc here is ok.
            let worker = Arc::try_unwrap(self.core_worker).map_err(|arc| {
                BridgeError::IllegalStateStillInUse {
                    what: "Worker",
                    details: Some(format!(
                        "Expected 1 reference, but got {}",
                        Arc::strong_count(&arc)
                    )),
                }
            })?;

            worker.finalize_shutdown().await;
            Ok(())
        });
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub struct HistoryForReplayTunnelHandle {
    core_runtime: Arc<CoreRuntime>,
    sender: Sender<HistoryForReplay>,
}

impl HistoryForReplayTunnelHandle {
    fn new(runtime: &Arc<CoreRuntime>) -> (Self, ReceiverStream<HistoryForReplay>) {
        let (sender, rx) = channel(1);
        (
            Self {
                core_runtime: Arc::clone(runtime),
                sender,
            },
            ReceiverStream::new(rx),
        )
    }

    pub(crate) fn get_chan(&self) -> Sender<HistoryForReplay> {
        self.sender.clone()
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Create a new replay worker asynchronously.
#[js_function]
pub fn replay_worker_new(
    runtime: OpaqueInboundHandle<Runtime>,
    config: config::BridgeWorkerOptions,
) -> BridgeResult<(
    OpaqueOutboundHandle<Worker>,
    OpaqueOutboundHandle<HistoryForReplayTunnelHandle>,
)> {
    let config = config
        .into_core_config()
        .context("Failed to convert WorkerOptions to CoreWorkerConfig")?;

    let runtime = runtime.borrow()?.core_runtime.clone();
    enter_sync!(runtime);

    let (tunnel, stream) = HistoryForReplayTunnelHandle::new(&runtime);

    let worker = init_replay_worker(ReplayWorkerInput::new(config, Box::pin(stream)))
        .context("Failed to initialize replay worker")?;

    let worker_handle = Worker {
        core_runtime: runtime,
        core_worker: Arc::new(worker),
    };

    Ok((
        OpaqueOutboundHandle::new(worker_handle),
        OpaqueOutboundHandle::new(tunnel),
    ))
}

#[js_function]
pub fn push_history(
    pusher: OpaqueInboundHandle<HistoryForReplayTunnelHandle>,
    workflow_id: String,
    history_binary: Vec<u8>,
) -> BridgeResult<BridgeFuture<()>> {
    let history: History =
        History::decode_length_delimited(history_binary.as_slice()).map_err(|err| {
            BridgeError::TypeError {
                field: None,
                message: format!("Cannot decode History from buffer: {err:?}"),
            }
        })?;
    let history = HistoryForReplay::new(history, workflow_id);

    let pusher_ref = pusher.borrow()?;
    let chan = pusher_ref.get_chan();

    pusher_ref.core_runtime.future_to_promise(async move {
        chan.send(history)
            .await
            .context("Error pushing history to replay worker")?;
        Ok(())
    })
}

#[js_function]
pub fn close_history_stream(
    pusher: OpaqueInboundHandle<HistoryForReplayTunnelHandle>,
) -> BridgeResult<()> {
    // Just drop the pusher's channel; there's actually no "close" method on the channel.
    let _pusher_ref = pusher.take()?;
    Ok(())
}

/// Let drop handle the cleanup.
impl MutableFinalize for HistoryForReplayTunnelHandle {}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use std::{sync::Arc, time::Duration};

    use temporal_sdk_core::{
        ResourceBasedSlotsOptions, ResourceBasedSlotsOptionsBuilder, ResourceSlotOptions,
        SlotSupplierOptions as CoreSlotSupplierOptions, TunerHolder, TunerHolderOptionsBuilder,
        api::worker::{
            ActivitySlotKind, LocalActivitySlotKind, NexusSlotKind,
            PollerBehavior as CorePollerBehavior, SlotKind, WorkerConfig, WorkerConfigBuilder,
            WorkerConfigBuilderError, WorkerDeploymentOptions as CoreWorkerDeploymentOptions,
            WorkerDeploymentVersion as CoreWorkerDeploymentVersion, WorkflowSlotKind,
        },
        protos::temporal::api::enums::v1::VersioningBehavior as CoreVersioningBehavior,
    };

    use super::custom_slot_supplier::CustomSlotSupplierOptions;
    use crate::helpers::TryIntoJs;
    use bridge_macros::TryFromJs;
    use neon::context::Context;
    use neon::object::Object;
    use neon::prelude::JsResult;
    use neon::types::JsObject;
    use temporal_sdk_core::api::worker::WorkerVersioningStrategy;

    #[derive(TryFromJs)]
    pub struct BridgeWorkerOptions {
        identity: String,
        build_id: String,
        use_versioning: bool,
        worker_deployment_options: Option<WorkerDeploymentOptions>,
        task_queue: String,
        namespace: String,
        tuner: WorkerTuner,
        non_sticky_to_sticky_poll_ratio: f32,
        workflow_task_poller_behavior: PollerBehavior,
        activity_task_poller_behavior: PollerBehavior,
        nexus_task_poller_behavior: PollerBehavior,
        enable_non_local_activities: bool,
        sticky_queue_schedule_to_start_timeout: Duration,
        max_cached_workflows: usize,
        max_heartbeat_throttle_interval: Duration,
        default_heartbeat_throttle_interval: Duration,
        max_activities_per_second: Option<f64>,
        max_task_queue_activities_per_second: Option<f64>,
        shutdown_grace_time: Option<Duration>,
    }

    #[derive(TryFromJs)]
    pub enum PollerBehavior {
        SimpleMaximum {
            maximum: usize,
        },
        Autoscaling {
            minimum: usize,
            maximum: usize,
            initial: usize,
        },
    }

    #[derive(TryFromJs)]
    pub struct WorkerDeploymentOptions {
        version: WorkerDeploymentVersion,
        use_worker_versioning: bool,
        default_versioning_behavior: VersioningBehavior,
    }

    #[derive(TryFromJs)]
    pub struct WorkerDeploymentVersion {
        build_id: String,
        deployment_name: String,
    }

    #[derive(TryFromJs)]
    pub enum VersioningBehavior {
        Pinned,
        AutoUpgrade,
    }

    impl BridgeWorkerOptions {
        pub(crate) fn into_core_config(self) -> Result<WorkerConfig, WorkerConfigBuilderError> {
            // Set all other options
            let mut builder = WorkerConfigBuilder::default();
            builder
                .client_identity_override(Some(self.identity))
                .versioning_strategy({
                    if let Some(dopts) = self.worker_deployment_options {
                        WorkerVersioningStrategy::WorkerDeploymentBased(dopts.into())
                    } else if self.use_versioning {
                        WorkerVersioningStrategy::LegacyBuildIdBased {
                            build_id: self.build_id,
                        }
                    } else {
                        WorkerVersioningStrategy::None {
                            build_id: self.build_id,
                        }
                    }
                })
                .task_queue(self.task_queue)
                .namespace(self.namespace)
                .tuner(self.tuner.into_core_config()?)
                .nonsticky_to_sticky_poll_ratio(self.non_sticky_to_sticky_poll_ratio)
                .workflow_task_poller_behavior(self.workflow_task_poller_behavior)
                .activity_task_poller_behavior(self.activity_task_poller_behavior)
                .nexus_task_poller_behavior(self.nexus_task_poller_behavior)
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

    impl From<PollerBehavior> for CorePollerBehavior {
        fn from(val: PollerBehavior) -> Self {
            match val {
                PollerBehavior::SimpleMaximum { maximum } => Self::SimpleMaximum(maximum),
                PollerBehavior::Autoscaling {
                    minimum,
                    maximum,
                    initial,
                } => Self::Autoscaling {
                    minimum,
                    maximum,
                    initial,
                },
            }
        }
    }

    impl From<WorkerDeploymentOptions> for CoreWorkerDeploymentOptions {
        fn from(val: WorkerDeploymentOptions) -> Self {
            Self {
                version: val.version.into(),
                use_worker_versioning: val.use_worker_versioning,
                default_versioning_behavior: Some(val.default_versioning_behavior.into()),
            }
        }
    }

    impl From<WorkerDeploymentVersion> for CoreWorkerDeploymentVersion {
        fn from(val: WorkerDeploymentVersion) -> Self {
            Self {
                build_id: val.build_id,
                deployment_name: val.deployment_name,
            }
        }
    }

    impl From<CoreWorkerDeploymentVersion> for WorkerDeploymentVersion {
        fn from(val: CoreWorkerDeploymentVersion) -> Self {
            Self {
                build_id: val.build_id,
                deployment_name: val.deployment_name,
            }
        }
    }

    impl TryIntoJs for WorkerDeploymentVersion {
        type Output = JsObject;

        fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output> {
            let obj = cx.empty_object();
            let bid = self.build_id.try_into_js(cx)?;
            obj.set(cx, "buildId", bid)?;
            let dn = self.deployment_name.try_into_js(cx)?;
            obj.set(cx, "deploymentName", dn)?;
            Ok(obj)
        }
    }

    impl From<VersioningBehavior> for CoreVersioningBehavior {
        fn from(val: VersioningBehavior) -> Self {
            match val {
                VersioningBehavior::Pinned => Self::Pinned,
                VersioningBehavior::AutoUpgrade => Self::AutoUpgrade,
            }
        }
    }

    #[derive(TryFromJs)]
    #[allow(clippy::struct_field_names)]
    pub(super) struct WorkerTuner {
        workflow_task_slot_supplier: SlotSupplier<WorkflowSlotKind>,
        activity_task_slot_supplier: SlotSupplier<ActivitySlotKind>,
        local_activity_task_slot_supplier: SlotSupplier<LocalActivitySlotKind>,
        nexus_task_slot_supplier: SlotSupplier<NexusSlotKind>,
    }

    impl WorkerTuner {
        fn into_core_config(self) -> Result<Arc<TunerHolder>, String> {
            let mut tuner_holder = TunerHolderOptionsBuilder::default();
            let mut rbo = None;

            tuner_holder.workflow_slot_options(
                self.workflow_task_slot_supplier
                    .into_slot_supplier(&mut rbo),
            );
            tuner_holder.activity_slot_options(
                self.activity_task_slot_supplier
                    .into_slot_supplier(&mut rbo),
            );
            tuner_holder.local_activity_slot_options(
                self.local_activity_task_slot_supplier
                    .into_slot_supplier(&mut rbo),
            );
            tuner_holder
                .nexus_slot_options(self.nexus_task_slot_supplier.into_slot_supplier(&mut rbo));
            if let Some(rbo) = rbo {
                tuner_holder.resource_based_options(rbo);
            }

            tuner_holder
                .build_tuner_holder()
                .map(Arc::new)
                .map_err(|e| format!("Invalid tuner options: {e:?}"))
        }
    }

    #[derive(TryFromJs)]
    pub(super) enum SlotSupplier<SK: SlotKind + Send + Sync + 'static> {
        FixedSize(FixedSizeSlotSupplierOptions),
        ResourceBased(ResourceBasedSlotSupplierOptions),
        Custom(CustomSlotSupplierOptions<SK>),
    }

    #[derive(TryFromJs)]
    pub(super) struct FixedSizeSlotSupplierOptions {
        num_slots: usize,
    }

    #[derive(TryFromJs)]
    pub(super) struct ResourceBasedSlotSupplierOptions {
        minimum_slots: usize,
        maximum_slots: usize,
        ramp_throttle: Duration,
        tuner_options: ResourceBasedTunerOptions,
    }

    #[derive(TryFromJs)]
    pub(super) struct ResourceBasedTunerOptions {
        target_memory_usage: f64,
        target_cpu_usage: f64,
    }

    impl<SK: SlotKind + Send + Sync + 'static> SlotSupplier<SK> {
        fn into_slot_supplier(
            self,
            rbo: &mut Option<ResourceBasedSlotsOptions>,
        ) -> CoreSlotSupplierOptions<SK> {
            match self {
                Self::FixedSize(opts) => CoreSlotSupplierOptions::FixedSize {
                    slots: opts.num_slots,
                },
                Self::ResourceBased(opts) => {
                    *rbo = Some(
                        ResourceBasedSlotsOptionsBuilder::default()
                            .target_cpu_usage(opts.tuner_options.target_cpu_usage)
                            .target_mem_usage(opts.tuner_options.target_memory_usage)
                            .build()
                            .expect("Building ResourceBasedSlotsOptions can't fail"),
                    );
                    CoreSlotSupplierOptions::ResourceBased(ResourceSlotOptions::new(
                        opts.minimum_slots,
                        opts.maximum_slots,
                        opts.ramp_throttle,
                    ))
                }
                Self::Custom(opts) => CoreSlotSupplierOptions::Custom(Arc::new(
                    super::custom_slot_supplier::SlotSupplierBridge::new(opts),
                )),
            }
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod custom_slot_supplier {
    use std::{marker::PhantomData, sync::Arc};

    use neon::{context::Context, handle::Handle, prelude::*};

    use temporal_sdk_core::{
        SlotSupplierOptions as CoreSlotSupplierOptions,
        api::worker::{
            SlotInfo as CoreSlotInfo, SlotInfoTrait as _, SlotKind,
            SlotKindType as CoreSlotKindType, SlotMarkUsedContext as CoreSlotMarkUsedContext,
            SlotReleaseContext as CoreSlotReleaseContext,
            SlotReservationContext as CoreSlotReservationContext, SlotSupplier as CoreSlotSupplier,
            SlotSupplierPermit as CoreSlotSupplierPermit,
        },
    };

    use bridge_macros::{TryFromJs, TryIntoJs};
    use tracing::warn;

    use crate::helpers::*;
    use crate::worker::config::WorkerDeploymentVersion;
    // Custom Slot Supplier ////////////////////////////////////////////////////////////////////////////

    pub(super) struct SlotSupplierBridge<SK: SlotKind + Send + Sync + 'static> {
        options: CustomSlotSupplierOptions<SK>,
    }

    impl<SK: SlotKind + Send + Sync + 'static> SlotSupplierBridge<SK> {
        pub(crate) const fn new(options: CustomSlotSupplierOptions<SK>) -> Self {
            Self { options }
        }
    }

    #[async_trait::async_trait]
    impl<SK: SlotKind + Send + Sync + 'static> CoreSlotSupplier for SlotSupplierBridge<SK> {
        type SlotKind = SK;

        async fn reserve_slot(
            &self,
            ctx: &dyn CoreSlotReservationContext,
        ) -> CoreSlotSupplierPermit {
            loop {
                let reserve_ctx = SlotReserveContext {
                    slot_type: SK::kind().into(),
                    task_queue: ctx.task_queue().to_string(),
                    worker_identity: ctx.worker_identity().to_string(),
                    worker_deployment_version: ctx
                        .worker_deployment_version()
                        .clone()
                        .map(Into::into),
                    is_sticky: ctx.is_sticky(),
                };

                let abort_controller = AbortController::new("Request Cancelled".to_string());

                let permit_result = self
                    .options
                    .reserve_slot
                    .call((reserve_ctx, abort_controller.get_signal()))
                    .await;

                // The call has already returned; it's no longer pertinent to trigger abort on drop
                abort_controller.disarm();

                match permit_result {
                    Ok(permit) => {
                        return CoreSlotSupplierPermit::with_user_data(BridgePermitData {
                            permit: Arc::new(permit),
                        });
                    }
                    Err(err) => {
                        warn!("Error reserving slot: {err:?}");
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
                worker_deployment_version: ctx.worker_deployment_version().clone().map(Into::into),
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
                    warn!("Error reserving {} slot: {:?}", SK::kind(), err);
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
    pub(super) struct CustomSlotSupplierOptions<SK: SlotKind + Send + Sync + 'static> {
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
                CoreSlotInfo::Workflow(info) => Self::Workflow {
                    workflow_type: info.workflow_type.to_string(),
                    is_sticky: info.is_sticky,
                },
                CoreSlotInfo::Activity(info) => Self::Activity {
                    activity_type: info.activity_type.to_string(),
                },
                CoreSlotInfo::LocalActivity(info) => Self::LocalActivity {
                    activity_type: info.activity_type.to_string(),
                },
                CoreSlotInfo::Nexus(info) => Self::Nexus {
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
        worker_deployment_version: Option<WorkerDeploymentVersion>,
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

    impl TryIntoJs for SlotKindType {
        type Output = JsString;
        fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, JsString> {
            let s = match self {
                Self::Workflow => "workflow",
                Self::Activity => "activity",
                Self::LocalActivity => "local-activity",
                Self::Nexus => "nexus",
            };
            Ok(cx.string(s))
        }
    }

    impl From<CoreSlotKindType> for SlotKindType {
        fn from(val: CoreSlotKindType) -> Self {
            match val {
                CoreSlotKindType::Workflow => Self::Workflow,
                CoreSlotKindType::Activity => Self::Activity,
                CoreSlotKindType::LocalActivity => Self::LocalActivity,
                CoreSlotKindType::Nexus => Self::Nexus,
            }
        }
    }

    /// `BridgePermitData` holds the data associated with a slot permit.
    struct BridgePermitData {
        permit: Arc<SlotPermitOpaqueData>,
    }

    /// An opaque handle to a root'd JS object.
    ///
    /// Note that even though the public API allows `permit` to be any JS value, including
    /// `undefined` or `null`, we may in fact only root JS _objects_ (including arrays and
    /// functions, but not primitives). For that reason, we wrap the user's JS value in a
    /// `JSObject`, and root that object instead.
    struct SlotPermitOpaqueData(Root<JsObject>);

    static PERMIT_DATA_FIELD: &str = "permit_data";

    impl TryFromJs for SlotPermitOpaqueData {
        fn try_from_js<'cx, 'b>(
            cx: &mut impl Context<'cx>,
            js_value: Handle<'b, JsValue>,
        ) -> BridgeResult<Self> {
            let obj = cx.empty_object();
            obj.set(cx, PERMIT_DATA_FIELD, js_value)?;
            Ok(Self(obj.root(cx)))
        }
    }

    impl TryIntoJs for Arc<SlotPermitOpaqueData> {
        type Output = JsValue;
        fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsValue> {
            let obj = self.as_ref().0.to_inner(cx);
            obj.get_value(cx, PERMIT_DATA_FIELD)
        }
    }
}
