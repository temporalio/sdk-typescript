use std::str::FromStr as _;
use std::time::Duration;
use std::{collections::HashMap, sync::Arc};

use neon::prelude::*;
use tonic::metadata::MetadataKey;

use temporal_sdk_core::{ClientOptions as CoreClientOptions, CoreRuntime, RetryClient};

use bridge_macros::{TryFromJs, js_function};
use temporal_client::{ClientInitError, ConfiguredClient, TemporalServiceClientWithMetrics};

use crate::runtime::Runtime;
use crate::{helpers::*, runtime::RuntimeExt as _};

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("newClient", client_new)?;
    cx.export_function("clientUpdateHeaders", client_update_headers)?;
    cx.export_function("clientUpdateApiKey", client_update_api_key)?;
    cx.export_function(
        "clientSendWorkflowServiceRequest",
        client_send_workflow_service_request,
    )?;
    cx.export_function(
        "clientSendOperatorServiceRequest",
        client_send_operator_service_request,
    )?;
    cx.export_function(
        "clientSendTestServiceRequest",
        client_send_test_service_request,
    )?;
    cx.export_function(
        "clientSendHealthServiceRequest",
        client_send_health_service_request,
    )?;
    cx.export_function("clientClose", client_close)?;

    Ok(())
}

type CoreClient = RetryClient<ConfiguredClient<TemporalServiceClientWithMetrics>>;

pub struct Client {
    // These fields are pub because they are accessed from Worker::new
    pub(crate) core_runtime: Arc<CoreRuntime>,
    pub(crate) core_client: CoreClient,
}

/// Create a connected gRPC client which can be used to initialize workers.
#[js_function]
pub fn client_new(
    runtime: OpaqueInboundHandle<Runtime>,
    config: config::ClientOptions,
) -> BridgeResult<BridgeFuture<OpaqueOutboundHandle<Client>>> {
    let runtime = runtime.borrow()?.core_runtime.clone();
    let config: CoreClientOptions = config.try_into()?;

    runtime.clone().future_to_promise(async move {
        let metric_meter = runtime.clone().telemetry().get_temporal_metric_meter();
        let res = config.connect_no_namespace(metric_meter).await;

        let core_client = match res {
            Ok(core_client) => core_client,
            Err(ClientInitError::SystemInfoCallError(e)) => Err(BridgeError::TransportError(
                format!("Failed to call GetSystemInfo: {e}"),
            ))?,
            Err(ClientInitError::TonicTransportError(e)) => {
                Err(BridgeError::TransportError(format!("{e:?}")))?
            }
            Err(ClientInitError::InvalidUri(e)) => Err(BridgeError::TypeError {
                message: e.to_string(),
                field: None,
            })?,
        };

        Ok(OpaqueOutboundHandle::new(Client {
            core_runtime: runtime,
            core_client,
        }))
    })
}

/// Update a Client's HTTP request headers
#[js_function]
pub fn client_update_headers(
    client: OpaqueInboundHandle<Client>,
    headers: HashMap<String, String>,
) -> BridgeResult<()> {
    client
        .borrow()?
        .core_client
        .get_client()
        .set_headers(headers);
    Ok(())
}

/// Update a Client's API key
#[js_function]
pub fn client_update_api_key(client: OpaqueInboundHandle<Client>, key: String) -> BridgeResult<()> {
    client
        .borrow()?
        .core_client
        .get_client()
        .set_api_key(Some(key));
    Ok(())
}

#[js_function]
pub fn client_close(client: OpaqueInboundHandle<Client>) -> BridgeResult<()> {
    // Just drop the client; there's actually no "close" method on Client.
    let _ = client.take()?;
    Ok(())
}

// Just drop the client, there's really nothing more to do.
impl MutableFinalize for Client {}

////////////////////////////////////////////////////////////////////////////////////////////////////

#[derive(Debug, TryFromJs)]
pub struct RpcCall {
    pub rpc: String,
    pub req: Vec<u8>,
    pub retry: bool,
    pub metadata: HashMap<String, String>,
    pub timeout: Option<Duration>,
}

/// Send a request to the Workflow Service using the provided Client
#[js_function]
pub fn client_send_workflow_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_client = client.core_client.clone();

    // FIXME: "large future with a size of 18560 bytes"
    core_runtime
        .future_to_promise(async move { client_invoke_workflow_service(core_client, call).await })
}

/// Send a request to the Operator Service using the provided Client
#[js_function]
pub fn client_send_operator_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_client = client.core_client.clone();

    core_runtime
        .future_to_promise(async move { client_invoke_operator_service(core_client, call).await })
}

/// Send a request to the Test Service using the provided Client
#[js_function]
pub fn client_send_test_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_client = client.core_client.clone();

    core_runtime
        .future_to_promise(async move { client_invoke_test_service(core_client, call).await })
}

/// Send a request to the Health Service using the provided Client
#[js_function]
pub fn client_send_health_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_client = client.core_client.clone();

    core_runtime
        .future_to_promise(async move { client_invoke_health_service(core_client, call).await })
}

/// Indicates that a gRPC request failed
const SERVICE_ERROR: &str = "ServiceError";

impl TryIntoJs for tonic::Status {
    type Output = JsError;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output> {
        let jsmetadata = cx.empty_object();

        let details = self.details();
        if !details.is_empty() {
            jsmetadata.set_property_from(cx, "grpc-status-details-bin", details)?;
        }

        let metadata = self.metadata().clone();
        for (k, v) in &metadata.into_headers() {
            let k: &str = k.as_ref();
            if k.ends_with("-bin") {
                jsmetadata.set_property_from(cx, k, v.as_bytes())?;
            } else {
                jsmetadata.set_property_from(cx, k, v.to_str().unwrap())?;
            }
        }

        let jserr = cx.error(self.message())?;
        jserr.set_property_from(cx, "name", SERVICE_ERROR)?;
        jserr.set_property_from(cx, "code", self.code() as u32)?;
        jserr.set_property(cx, "metadata", jsmetadata)?;

        Ok(jserr)
    }
}

macro_rules! rpc_call {
    ($retry_client:ident, $call:ident, $call_name:ident) => {
        if $call.retry {
            rpc_resp($retry_client.$call_name(rpc_req($call)?).await)
        } else {
            rpc_resp($retry_client.into_inner().$call_name(rpc_req($call)?).await)
        }
    };
}

// FIXME: "this function may allocate 1400106 bytes on the stack"
#[allow(clippy::too_many_lines)]
async fn client_invoke_workflow_service(
    mut retry_client: CoreClient,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporal_client::WorkflowService;

    match call.rpc.as_str() {
        "CountWorkflowExecutions" => {
            rpc_call!(retry_client, call, count_workflow_executions)
        }
        "CreateSchedule" => {
            rpc_call!(retry_client, call, create_schedule)
        }
        "CreateWorkflowRule" => {
            rpc_call!(retry_client, call, create_workflow_rule)
        }
        "DeleteSchedule" => {
            rpc_call!(retry_client, call, delete_schedule)
        }
        "DeleteWorkerDeployment" => {
            rpc_call!(retry_client, call, delete_worker_deployment)
        }
        "DeleteWorkerDeploymentVersion" => {
            rpc_call!(retry_client, call, delete_worker_deployment_version)
        }
        "DeleteWorkflowExecution" => {
            rpc_call!(retry_client, call, delete_workflow_execution)
        }
        "DeleteWorkflowRule" => {
            rpc_call!(retry_client, call, delete_workflow_rule)
        }
        "DescribeBatchOperation" => {
            rpc_call!(retry_client, call, describe_batch_operation)
        }
        "DescribeDeployment" => {
            rpc_call!(retry_client, call, describe_deployment)
        }
        "DeprecateNamespace" => rpc_call!(retry_client, call, deprecate_namespace),
        "DescribeNamespace" => rpc_call!(retry_client, call, describe_namespace),
        "DescribeSchedule" => rpc_call!(retry_client, call, describe_schedule),
        "DescribeTaskQueue" => rpc_call!(retry_client, call, describe_task_queue),
        "DescribeWorkerDeployment" => {
            rpc_call!(retry_client, call, describe_worker_deployment)
        }
        "DescribeWorkerDeploymentVersion" => {
            rpc_call!(retry_client, call, describe_worker_deployment_version)
        }
        "DescribeWorkflowExecution" => {
            rpc_call!(retry_client, call, describe_workflow_execution)
        }
        "DescribeWorkflowRule" => {
            rpc_call!(retry_client, call, describe_workflow_rule)
        }
        "ExecuteMultiOperation" => rpc_call!(retry_client, call, execute_multi_operation),
        "FetchWorkerConfig" => rpc_call!(retry_client, call, fetch_worker_config),
        "GetClusterInfo" => rpc_call!(retry_client, call, get_cluster_info),
        "GetCurrentDeployment" => rpc_call!(retry_client, call, get_current_deployment),
        "GetDeploymentReachability" => {
            rpc_call!(retry_client, call, get_deployment_reachability)
        }
        "GetSearchAttributes" => {
            rpc_call!(retry_client, call, get_search_attributes)
        }
        "GetSystemInfo" => rpc_call!(retry_client, call, get_system_info),
        "GetWorkerBuildIdCompatibility" => {
            rpc_call!(retry_client, call, get_worker_build_id_compatibility)
        }
        "GetWorkerTaskReachability" => {
            rpc_call!(retry_client, call, get_worker_task_reachability)
        }
        "GetWorkerVersioningRules" => {
            rpc_call!(retry_client, call, get_worker_versioning_rules)
        }
        "GetWorkflowExecutionHistory" => {
            rpc_call!(retry_client, call, get_workflow_execution_history)
        }
        "GetWorkflowExecutionHistoryReverse" => {
            rpc_call!(retry_client, call, get_workflow_execution_history_reverse)
        }
        "ListArchivedWorkflowExecutions" => {
            rpc_call!(retry_client, call, list_archived_workflow_executions)
        }
        "ListBatchOperations" => {
            rpc_call!(retry_client, call, list_batch_operations)
        }
        "ListClosedWorkflowExecutions" => {
            rpc_call!(retry_client, call, list_closed_workflow_executions)
        }
        "ListDeployments" => {
            rpc_call!(retry_client, call, list_deployments)
        }
        "ListNamespaces" => rpc_call!(retry_client, call, list_namespaces),
        "ListOpenWorkflowExecutions" => {
            rpc_call!(retry_client, call, list_open_workflow_executions)
        }
        "ListScheduleMatchingTimes" => {
            rpc_call!(retry_client, call, list_schedule_matching_times)
        }
        "ListSchedules" => {
            rpc_call!(retry_client, call, list_schedules)
        }
        "ListTaskQueuePartitions" => {
            rpc_call!(retry_client, call, list_task_queue_partitions)
        }
        "ListWorkerDeployments" => {
            rpc_call!(retry_client, call, list_worker_deployments)
        }
        "ListWorkers" => {
            rpc_call!(retry_client, call, list_workers)
        }
        "ListWorkflowExecutions" => {
            rpc_call!(retry_client, call, list_workflow_executions)
        }
        "ListWorkflowRules" => {
            rpc_call!(retry_client, call, list_workflow_rules)
        }
        "PatchSchedule" => {
            rpc_call!(retry_client, call, patch_schedule)
        }
        "PauseActivity" => {
            rpc_call!(retry_client, call, pause_activity)
        }
        "PollActivityTaskQueue" => {
            rpc_call!(retry_client, call, poll_activity_task_queue)
        }
        "PollNexusTaskQueue" => rpc_call!(retry_client, call, poll_nexus_task_queue),
        "PollWorkflowExecutionUpdate" => {
            rpc_call!(retry_client, call, poll_workflow_execution_update)
        }
        "PollWorkflowTaskQueue" => {
            rpc_call!(retry_client, call, poll_workflow_task_queue)
        }
        "QueryWorkflow" => rpc_call!(retry_client, call, query_workflow),
        "RecordActivityTaskHeartbeat" => {
            rpc_call!(retry_client, call, record_activity_task_heartbeat)
        }
        "RecordActivityTaskHeartbeatById" => {
            rpc_call!(retry_client, call, record_activity_task_heartbeat_by_id)
        }
        "RecordWorkerHeartbeat" => {
            rpc_call!(retry_client, call, record_worker_heartbeat)
        }
        "RegisterNamespace" => rpc_call!(retry_client, call, register_namespace),
        "RequestCancelWorkflowExecution" => {
            rpc_call!(retry_client, call, request_cancel_workflow_execution)
        }
        "ResetActivity" => {
            rpc_call!(retry_client, call, reset_activity)
        }
        "ResetStickyTaskQueue" => {
            rpc_call!(retry_client, call, reset_sticky_task_queue)
        }
        "ResetWorkflowExecution" => {
            rpc_call!(retry_client, call, reset_workflow_execution)
        }
        "RespondActivityTaskCanceled" => {
            rpc_call!(retry_client, call, respond_activity_task_canceled)
        }
        "RespondActivityTaskCanceledById" => {
            rpc_call!(retry_client, call, respond_activity_task_canceled_by_id)
        }
        "RespondActivityTaskCompleted" => {
            rpc_call!(retry_client, call, respond_activity_task_completed)
        }
        "RespondActivityTaskCompletedById" => {
            rpc_call!(retry_client, call, respond_activity_task_completed_by_id)
        }
        "RespondActivityTaskFailed" => {
            rpc_call!(retry_client, call, respond_activity_task_failed)
        }
        "RespondActivityTaskFailedById" => {
            rpc_call!(retry_client, call, respond_activity_task_failed_by_id)
        }
        "RespondNexusTaskCompleted" => {
            rpc_call!(retry_client, call, respond_nexus_task_completed)
        }
        "RespondNexusTaskFailed" => {
            rpc_call!(retry_client, call, respond_nexus_task_failed)
        }
        "RespondQueryTaskCompleted" => {
            rpc_call!(retry_client, call, respond_query_task_completed)
        }
        "RespondWorkflowTaskCompleted" => {
            rpc_call!(retry_client, call, respond_workflow_task_completed)
        }
        "RespondWorkflowTaskFailed" => {
            rpc_call!(retry_client, call, respond_workflow_task_failed)
        }
        "ScanWorkflowExecutions" => {
            rpc_call!(retry_client, call, scan_workflow_executions)
        }
        "SetCurrentDeployment" => {
            rpc_call!(retry_client, call, set_current_deployment)
        }
        "SetWorkerDeploymentCurrentVersion" => {
            rpc_call!(retry_client, call, set_worker_deployment_current_version)
        }
        "SetWorkerDeploymentRampingVersion" => {
            rpc_call!(retry_client, call, set_worker_deployment_ramping_version)
        }
        "ShutdownWorker" => {
            rpc_call!(retry_client, call, shutdown_worker)
        }
        "SignalWithStartWorkflowExecution" => {
            rpc_call!(retry_client, call, signal_with_start_workflow_execution)
        }
        "SignalWorkflowExecution" => {
            rpc_call!(retry_client, call, signal_workflow_execution)
        }
        "StartWorkflowExecution" => {
            rpc_call!(retry_client, call, start_workflow_execution)
        }
        "StartBatchOperation" => {
            rpc_call!(retry_client, call, start_batch_operation)
        }
        "StopBatchOperation" => {
            rpc_call!(retry_client, call, stop_batch_operation)
        }
        "TerminateWorkflowExecution" => {
            rpc_call!(retry_client, call, terminate_workflow_execution)
        }
        "TriggerWorkflowRule" => {
            rpc_call!(retry_client, call, trigger_workflow_rule)
        }
        "UnpauseActivity" => {
            rpc_call!(retry_client, call, unpause_activity)
        }
        "UpdateActivityOptions" => {
            rpc_call!(retry_client, call, update_activity_options)
        }
        "UpdateNamespace" => {
            rpc_call!(retry_client, call, update_namespace)
        }
        "UpdateSchedule" => rpc_call!(retry_client, call, update_schedule),
        "UpdateWorkerConfig" => rpc_call!(retry_client, call, update_worker_config),
        "UpdateWorkerDeploymentVersionMetadata" => {
            rpc_call!(
                retry_client,
                call,
                update_worker_deployment_version_metadata
            )
        }
        "UpdateTaskQueueConfig" => {
            rpc_call!(retry_client, call, update_task_queue_config)
        }
        "UpdateWorkflowExecution" => {
            rpc_call!(retry_client, call, update_workflow_execution)
        }
        "UpdateWorkflowExecutionOptions" => {
            rpc_call!(retry_client, call, update_workflow_execution_options)
        }
        "UpdateWorkerBuildIdCompatibility" => {
            rpc_call!(retry_client, call, update_worker_build_id_compatibility)
        }
        "UpdateWorkerVersioningRules" => {
            rpc_call!(retry_client, call, update_worker_versioning_rules)
        }
        _ => Err(BridgeError::TypeError {
            field: None,
            message: format!("Unknown RPC call {}", call.rpc),
        }),
    }
}

async fn client_invoke_operator_service(
    mut retry_client: CoreClient,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporal_client::OperatorService;

    match call.rpc.as_str() {
        "AddOrUpdateRemoteCluster" => {
            rpc_call!(retry_client, call, add_or_update_remote_cluster)
        }
        "AddSearchAttributes" => {
            rpc_call!(retry_client, call, add_search_attributes)
        }
        "CreateNexusEndpoint" => rpc_call!(retry_client, call, create_nexus_endpoint),
        "DeleteNamespace" => {
            rpc_call!(retry_client, call, delete_namespace)
        }
        "DeleteNexusEndpoint" => rpc_call!(retry_client, call, delete_nexus_endpoint),
        "GetNexusEndpoint" => rpc_call!(retry_client, call, get_nexus_endpoint),
        "ListClusters" => rpc_call!(retry_client, call, list_clusters),
        "ListNexusEndpoints" => rpc_call!(retry_client, call, list_nexus_endpoints),
        "ListSearchAttributes" => {
            rpc_call!(retry_client, call, list_search_attributes)
        }
        "RemoveRemoteCluster" => {
            rpc_call!(retry_client, call, remove_remote_cluster)
        }
        "RemoveSearchAttributes" => {
            rpc_call!(retry_client, call, remove_search_attributes)
        }
        "UpdateNexusEndpoint" => rpc_call!(retry_client, call, update_nexus_endpoint),
        _ => Err(BridgeError::TypeError {
            field: None,
            message: format!("Unknown RPC call {}", call.rpc),
        }),
    }
}

async fn client_invoke_test_service(
    mut retry_client: CoreClient,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporal_client::TestService;

    match call.rpc.as_str() {
        "GetCurrentTime" => rpc_call!(retry_client, call, get_current_time),
        "LockTimeSkipping" => rpc_call!(retry_client, call, lock_time_skipping),
        "SleepUntil" => rpc_call!(retry_client, call, sleep_until),
        "Sleep" => rpc_call!(retry_client, call, sleep),
        "UnlockTimeSkippingWithSleep" => {
            rpc_call!(retry_client, call, unlock_time_skipping_with_sleep)
        }
        "UnlockTimeSkipping" => rpc_call!(retry_client, call, unlock_time_skipping),
        _ => Err(BridgeError::TypeError {
            field: None,
            message: format!("Unknown RPC call {}", call.rpc),
        }),
    }
}

async fn client_invoke_health_service(
    mut retry_client: CoreClient,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporal_client::HealthService;

    match call.rpc.as_str() {
        "Check" => rpc_call!(retry_client, call, check),
        // Intentionally ignore 'watch' because it's a streaming method, which is not currently
        // supported by the macro and client-side code, and not needed anyway for any SDK use case.
        _ => Err(BridgeError::TypeError {
            field: None,
            message: format!("Unknown RPC call {}", call.rpc),
        }),
    }
}

fn rpc_req<P: prost::Message + Default>(call: RpcCall) -> BridgeResult<tonic::Request<P>> {
    let proto = P::decode(&*call.req).map_err(|err| BridgeError::TypeError {
        field: None,
        message: format!("Cannot decode response from buffer: {err:?}"),
    })?;

    let mut req = tonic::Request::new(proto);
    for (k, v) in call.metadata {
        req.metadata_mut().insert(
            MetadataKey::from_str(k.as_str()).map_err(|err| BridgeError::TypeError {
                field: None,
                message: format!("Invalid metadata key: {err}"),
            })?,
            v.parse().map_err(|err| BridgeError::TypeError {
                field: None,
                message: format!("Invalid metadata value: {err}"),
            })?,
        );
    }

    if let Some(timeout) = call.timeout {
        req.set_timeout(timeout);
    }

    Ok(req)
}

fn rpc_resp<P>(res: Result<tonic::Response<P>, tonic::Status>) -> BridgeResult<Vec<u8>>
where
    P: prost::Message + Default,
{
    match res {
        Ok(resp) => Ok(resp.get_ref().encode_to_vec()),
        Err(err) => Err(BridgeError::ServiceError(err)),
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use std::collections::HashMap;

    use anyhow::Context as _;

    use temporal_client::HttpConnectProxyOptions;
    use temporal_sdk_core::{
        ClientOptions as CoreClientOptions, ClientOptionsBuilder,
        ClientTlsConfig as CoreClientTlsConfig, TlsConfig as CoreTlsConfig, Url,
    };

    use bridge_macros::TryFromJs;

    use crate::helpers::*;

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct ClientOptions {
        target_url: Url,
        client_name: String,
        client_version: String,
        tls: Option<TlsConfig>,
        http_connect_proxy: Option<HttpConnectProxy>,
        headers: Option<HashMap<String, String>>,
        api_key: Option<String>,
        disable_error_code_metric_tags: bool,
    }

    #[derive(Debug, Clone, TryFromJs)]
    #[allow(clippy::struct_field_names)]
    struct TlsConfig {
        domain: Option<String>,
        server_root_ca_cert: Option<Vec<u8>>,
        client_tls_config: Option<TlsConfigClientCertPair>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct TlsConfigClientCertPair {
        client_cert: Vec<u8>,
        client_private_key: Vec<u8>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct HttpConnectProxy {
        target_host: String,
        basic_auth: Option<HttpConnectProxyBasicAuth>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct HttpConnectProxyBasicAuth {
        username: String,
        password: String,
    }

    impl TryInto<CoreClientOptions> for ClientOptions {
        type Error = BridgeError;
        fn try_into(self) -> Result<CoreClientOptions, Self::Error> {
            let mut builder = ClientOptionsBuilder::default();

            if let Some(tls) = self.tls {
                builder.tls_cfg(tls.into());
            }

            let client_options = builder
                .target_url(self.target_url)
                .client_name(self.client_name)
                .client_version(self.client_version)
                // tls_cfg -- above
                .http_connect_proxy(self.http_connect_proxy.map(Into::into))
                .headers(self.headers)
                .api_key(self.api_key)
                .disable_error_code_metric_tags(self.disable_error_code_metric_tags)
                // identity -- skipped: will be set on worker
                // retry_config -- skipped: worker overrides anyway
                // override_origin -- skipped: will default to tls_cfg.domain
                // keep_alive -- skipped: defaults to true; is there any reason to disable this?
                // skip_get_system_info -- skipped: defaults to false; is there any reason to set this?
                .build()
                .context("Invalid Client options")?;

            Ok(client_options)
        }
    }

    impl From<TlsConfig> for CoreTlsConfig {
        fn from(val: TlsConfig) -> Self {
            Self {
                domain: val.domain,
                server_root_ca_cert: val.server_root_ca_cert,
                client_tls_config: val.client_tls_config.map(|pair| CoreClientTlsConfig {
                    client_cert: pair.client_cert,
                    client_private_key: pair.client_private_key,
                }),
            }
        }
    }

    impl From<HttpConnectProxy> for HttpConnectProxyOptions {
        fn from(val: HttpConnectProxy) -> Self {
            Self {
                target_addr: val.target_host,
                basic_auth: val.basic_auth.map(|auth| (auth.username, auth.password)),
            }
        }
    }
}
