use std::str::FromStr as _;
use std::time::Duration;
use std::{collections::HashMap, sync::Arc};

use neon::prelude::*;
use tonic::metadata::{BinaryMetadataValue, MetadataKey};

use temporalio_sdk_core::CoreRuntime;

use bridge_macros::{TryFromJs, js_function};
use temporalio_client::{Connection, errors::ClientConnectError};

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

pub struct Client {
    // These fields are pub because they are accessed from Worker::new
    pub(crate) core_runtime: Arc<CoreRuntime>,
    pub(crate) core_connection: Connection,
}

/// Create a connected gRPC client which can be used to initialize workers.
#[js_function]
pub fn client_new(
    runtime: OpaqueInboundHandle<Runtime>,
    config: config::ClientOptions,
) -> BridgeResult<BridgeFuture<OpaqueOutboundHandle<Client>>> {
    let runtime = runtime.borrow()?.core_runtime.clone();
    let metric_meter = runtime.telemetry().get_temporal_metric_meter();
    let options = config.into_connection_options(metric_meter);

    runtime.clone().future_to_promise(async move {
        let core_connection = match Connection::connect(options).await {
            Ok(conn) => conn,
            Err(ClientConnectError::InvalidHeaders(e)) => Err(BridgeError::TypeError {
                message: format!("Invalid metadata key: {e}"),
                field: None,
            })?,
            Err(ClientConnectError::SystemInfoCallError(e)) => Err(BridgeError::TransportError(
                format!("Failed to call GetSystemInfo: {e}"),
            ))?,
            Err(ClientConnectError::TonicTransportError(e)) => {
                Err(BridgeError::TransportError(format!("{e:?}")))?
            }
            Err(ClientConnectError::InvalidUri(e)) => Err(BridgeError::TypeError {
                message: e.to_string(),
                field: None,
            })?,
            Err(e) => Err(BridgeError::TransportError(format!("{e:?}")))?,
        };

        Ok(OpaqueOutboundHandle::new(Client {
            core_runtime: runtime,
            core_connection,
        }))
    })
}

/// Update a Client's HTTP request headers
#[js_function]
pub fn client_update_headers(
    client: OpaqueInboundHandle<Client>,
    headers: HashMap<String, MetadataValue>,
) -> BridgeResult<()> {
    let (ascii_headers, bin_headers) = config::partition_headers(Some(headers));
    client
        .borrow()?
        .core_connection
        .set_headers(ascii_headers.unwrap_or_default())
        .map_err(|err| BridgeError::TypeError {
            message: format!("Invalid metadata key: {err}"),
            field: None,
        })?;
    client
        .borrow()?
        .core_connection
        .set_binary_headers(bin_headers.unwrap_or_default())
        .map_err(|err| BridgeError::TypeError {
            message: format!("Invalid metadata key: {err}"),
            field: None,
        })?;
    Ok(())
}

/// Update a Client's API key
#[js_function]
pub fn client_update_api_key(client: OpaqueInboundHandle<Client>, key: String) -> BridgeResult<()> {
    client.borrow()?.core_connection.set_api_key(Some(key));
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
    pub metadata: HashMap<String, MetadataValue>,
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone, TryFromJs)]
pub enum MetadataValue {
    Ascii { value: String },
    Binary { value: Vec<u8> },
}

/// Send a request to the Workflow Service using the provided Client
#[js_function]
pub fn client_send_workflow_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_connection = client.core_connection.clone();

    // FIXME: "large future with a size of 18560 bytes"
    core_runtime.future_to_promise(async move {
        client_invoke_workflow_service(core_connection, call).await
    })
}

/// Send a request to the Operator Service using the provided Client
#[js_function]
pub fn client_send_operator_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_connection = client.core_connection.clone();

    core_runtime.future_to_promise(async move {
        client_invoke_operator_service(core_connection, call).await
    })
}

/// Send a request to the Test Service using the provided Client
#[js_function]
pub fn client_send_test_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_connection = client.core_connection.clone();

    core_runtime
        .future_to_promise(async move { client_invoke_test_service(core_connection, call).await })
}

/// Send a request to the Health Service using the provided Client
#[js_function]
pub fn client_send_health_service_request(
    client: OpaqueInboundHandle<Client>,
    call: RpcCall,
) -> BridgeResult<BridgeFuture<Vec<u8>>> {
    let client = client.borrow()?;
    let core_runtime = client.core_runtime.clone();
    let core_connection = client.core_connection.clone();

    core_runtime
        .future_to_promise(async move { client_invoke_health_service(core_connection, call).await })
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
    ($connection:ident, $call:ident, $call_name:ident) => {
        rpc_call!($connection, $call, $call_name, workflow_service)
    };
    ($connection:ident, $call:ident, $call_name:ident, $service_accessor:ident) => {
        if $call.retry {
            rpc_resp($connection.$call_name(rpc_req($call)?).await)
        } else {
            rpc_resp(
                $connection
                    .$service_accessor()
                    .$call_name(rpc_req($call)?)
                    .await,
            )
        }
    };
}

// FIXME: "this function may allocate 1400106 bytes on the stack"
#[allow(clippy::cognitive_complexity)]
#[allow(clippy::large_stack_frames)]
#[allow(clippy::too_many_lines)]
async fn client_invoke_workflow_service(
    mut connection: Connection,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporalio_client::grpc::WorkflowService;

    match call.rpc.as_str() {
        "CountActivityExecutions" => rpc_call!(connection, call, count_activity_executions),
        "CountSchedules" => rpc_call!(connection, call, count_schedules),
        "CountWorkflowExecutions" => rpc_call!(connection, call, count_workflow_executions),
        "CreateSchedule" => rpc_call!(connection, call, create_schedule),
        "CreateWorkflowRule" => rpc_call!(connection, call, create_workflow_rule),
        "DeleteActivityExecution" => rpc_call!(connection, call, delete_activity_execution),
        "DeleteSchedule" => rpc_call!(connection, call, delete_schedule),
        "DeleteWorkerDeployment" => rpc_call!(connection, call, delete_worker_deployment),
        "DeleteWorkerDeploymentVersion" => {
            rpc_call!(connection, call, delete_worker_deployment_version)
        }
        "DeleteWorkflowExecution" => rpc_call!(connection, call, delete_workflow_execution),
        "DeleteWorkflowRule" => rpc_call!(connection, call, delete_workflow_rule),
        "DescribeBatchOperation" => rpc_call!(connection, call, describe_batch_operation),
        "DescribeActivityExecution" => rpc_call!(connection, call, describe_activity_execution),
        "DescribeDeployment" => rpc_call!(connection, call, describe_deployment),
        "DescribeWorker" => rpc_call!(connection, call, describe_worker),
        "DeprecateNamespace" => rpc_call!(connection, call, deprecate_namespace),
        "DescribeNamespace" => rpc_call!(connection, call, describe_namespace),
        "DescribeSchedule" => rpc_call!(connection, call, describe_schedule),
        "DescribeTaskQueue" => rpc_call!(connection, call, describe_task_queue),
        "DescribeWorkerDeployment" => rpc_call!(connection, call, describe_worker_deployment),
        "DescribeWorkerDeploymentVersion" => {
            rpc_call!(connection, call, describe_worker_deployment_version)
        }
        "DescribeWorkflowExecution" => rpc_call!(connection, call, describe_workflow_execution),
        "DescribeWorkflowRule" => rpc_call!(connection, call, describe_workflow_rule),
        "ExecuteMultiOperation" => rpc_call!(connection, call, execute_multi_operation),
        "FetchWorkerConfig" => rpc_call!(connection, call, fetch_worker_config),
        "GetClusterInfo" => rpc_call!(connection, call, get_cluster_info),
        "GetCurrentDeployment" => rpc_call!(connection, call, get_current_deployment),
        "GetDeploymentReachability" => rpc_call!(connection, call, get_deployment_reachability),
        "GetSearchAttributes" => rpc_call!(connection, call, get_search_attributes),
        "GetSystemInfo" => rpc_call!(connection, call, get_system_info),
        "GetWorkerBuildIdCompatibility" => {
            rpc_call!(connection, call, get_worker_build_id_compatibility)
        }
        "GetWorkerTaskReachability" => rpc_call!(connection, call, get_worker_task_reachability),
        "GetWorkerVersioningRules" => rpc_call!(connection, call, get_worker_versioning_rules),
        "GetWorkflowExecutionHistory" => {
            rpc_call!(connection, call, get_workflow_execution_history)
        }
        "GetWorkflowExecutionHistoryReverse" => {
            rpc_call!(connection, call, get_workflow_execution_history_reverse)
        }
        "ListArchivedWorkflowExecutions" => {
            rpc_call!(connection, call, list_archived_workflow_executions)
        }
        "ListActivityExecutions" => rpc_call!(connection, call, list_activity_executions),
        "ListBatchOperations" => rpc_call!(connection, call, list_batch_operations),
        "ListClosedWorkflowExecutions" => {
            rpc_call!(connection, call, list_closed_workflow_executions)
        }
        "ListDeployments" => rpc_call!(connection, call, list_deployments),
        "ListNamespaces" => rpc_call!(connection, call, list_namespaces),
        "ListOpenWorkflowExecutions" => rpc_call!(connection, call, list_open_workflow_executions),
        "ListScheduleMatchingTimes" => rpc_call!(connection, call, list_schedule_matching_times),
        "ListSchedules" => rpc_call!(connection, call, list_schedules),
        "ListTaskQueuePartitions" => rpc_call!(connection, call, list_task_queue_partitions),
        "ListWorkerDeployments" => rpc_call!(connection, call, list_worker_deployments),
        "ListWorkers" => rpc_call!(connection, call, list_workers),
        "ListWorkflowExecutions" => rpc_call!(connection, call, list_workflow_executions),
        "ListWorkflowRules" => rpc_call!(connection, call, list_workflow_rules),
        "PatchSchedule" => rpc_call!(connection, call, patch_schedule),
        "PauseActivity" => rpc_call!(connection, call, pause_activity),
        "PauseWorkflowExecution" => rpc_call!(connection, call, pause_workflow_execution),
        "PollActivityExecution" => rpc_call!(connection, call, poll_activity_execution),
        "PollActivityTaskQueue" => rpc_call!(connection, call, poll_activity_task_queue),
        "PollNexusTaskQueue" => rpc_call!(connection, call, poll_nexus_task_queue),
        "PollWorkflowExecutionUpdate" => {
            rpc_call!(connection, call, poll_workflow_execution_update)
        }
        "PollWorkflowTaskQueue" => rpc_call!(connection, call, poll_workflow_task_queue),
        "QueryWorkflow" => rpc_call!(connection, call, query_workflow),
        "RecordActivityTaskHeartbeat" => {
            rpc_call!(connection, call, record_activity_task_heartbeat)
        }
        "RecordActivityTaskHeartbeatById" => {
            rpc_call!(connection, call, record_activity_task_heartbeat_by_id)
        }
        "RecordWorkerHeartbeat" => rpc_call!(connection, call, record_worker_heartbeat),
        "RegisterNamespace" => rpc_call!(connection, call, register_namespace),
        "RequestCancelActivityExecution" => {
            rpc_call!(connection, call, request_cancel_activity_execution)
        }
        "RequestCancelWorkflowExecution" => {
            rpc_call!(connection, call, request_cancel_workflow_execution)
        }
        "ResetActivity" => rpc_call!(connection, call, reset_activity),
        "ResetStickyTaskQueue" => rpc_call!(connection, call, reset_sticky_task_queue),
        "ResetWorkflowExecution" => rpc_call!(connection, call, reset_workflow_execution),
        "RespondActivityTaskCanceled" => {
            rpc_call!(connection, call, respond_activity_task_canceled)
        }
        "RespondActivityTaskCanceledById" => {
            rpc_call!(connection, call, respond_activity_task_canceled_by_id)
        }
        "RespondActivityTaskCompleted" => {
            rpc_call!(connection, call, respond_activity_task_completed)
        }
        "RespondActivityTaskCompletedById" => {
            rpc_call!(connection, call, respond_activity_task_completed_by_id)
        }
        "RespondActivityTaskFailed" => rpc_call!(connection, call, respond_activity_task_failed),
        "RespondActivityTaskFailedById" => {
            rpc_call!(connection, call, respond_activity_task_failed_by_id)
        }
        "RespondNexusTaskCompleted" => rpc_call!(connection, call, respond_nexus_task_completed),
        "RespondNexusTaskFailed" => rpc_call!(connection, call, respond_nexus_task_failed),
        "RespondQueryTaskCompleted" => rpc_call!(connection, call, respond_query_task_completed),
        "RespondWorkflowTaskCompleted" => {
            rpc_call!(connection, call, respond_workflow_task_completed)
        }
        "RespondWorkflowTaskFailed" => rpc_call!(connection, call, respond_workflow_task_failed),
        "ScanWorkflowExecutions" => rpc_call!(connection, call, scan_workflow_executions),
        "SetCurrentDeployment" => rpc_call!(connection, call, set_current_deployment),
        "SetWorkerDeploymentCurrentVersion" => {
            rpc_call!(connection, call, set_worker_deployment_current_version)
        }
        "SetWorkerDeploymentManager" => rpc_call!(connection, call, set_worker_deployment_manager),
        "SetWorkerDeploymentRampingVersion" => {
            rpc_call!(connection, call, set_worker_deployment_ramping_version)
        }
        "ShutdownWorker" => rpc_call!(connection, call, shutdown_worker),
        "SignalWithStartWorkflowExecution" => {
            rpc_call!(connection, call, signal_with_start_workflow_execution)
        }
        "SignalWorkflowExecution" => rpc_call!(connection, call, signal_workflow_execution),
        "StartActivityExecution" => rpc_call!(connection, call, start_activity_execution),
        "StartWorkflowExecution" => rpc_call!(connection, call, start_workflow_execution),
        "StartBatchOperation" => rpc_call!(connection, call, start_batch_operation),
        "StopBatchOperation" => rpc_call!(connection, call, stop_batch_operation),
        "TerminateActivityExecution" => rpc_call!(connection, call, terminate_activity_execution),
        "TerminateWorkflowExecution" => rpc_call!(connection, call, terminate_workflow_execution),
        "TriggerWorkflowRule" => rpc_call!(connection, call, trigger_workflow_rule),
        "UnpauseActivity" => rpc_call!(connection, call, unpause_activity),
        "UnpauseWorkflowExecution" => rpc_call!(connection, call, unpause_workflow_execution),
        "UpdateActivityOptions" => rpc_call!(connection, call, update_activity_options),
        "UpdateNamespace" => rpc_call!(connection, call, update_namespace),
        "UpdateSchedule" => rpc_call!(connection, call, update_schedule),
        "UpdateWorkerConfig" => rpc_call!(connection, call, update_worker_config),
        "UpdateWorkerDeploymentVersionMetadata" => {
            rpc_call!(connection, call, update_worker_deployment_version_metadata)
        }
        "UpdateTaskQueueConfig" => rpc_call!(connection, call, update_task_queue_config),
        "UpdateWorkflowExecution" => rpc_call!(connection, call, update_workflow_execution),
        "UpdateWorkflowExecutionOptions" => {
            rpc_call!(connection, call, update_workflow_execution_options)
        }
        "UpdateWorkerBuildIdCompatibility" => {
            rpc_call!(connection, call, update_worker_build_id_compatibility)
        }
        "UpdateWorkerVersioningRules" => {
            rpc_call!(connection, call, update_worker_versioning_rules)
        }
        _ => Err(BridgeError::TypeError {
            field: None,
            message: format!("Unknown RPC call {}", call.rpc),
        }),
    }
}

#[allow(clippy::cognitive_complexity)]
async fn client_invoke_operator_service(
    mut connection: Connection,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporalio_client::grpc::OperatorService;

    match call.rpc.as_str() {
        "AddOrUpdateRemoteCluster" => {
            rpc_call!(
                connection,
                call,
                add_or_update_remote_cluster,
                operator_service
            )
        }
        "AddSearchAttributes" => {
            rpc_call!(connection, call, add_search_attributes, operator_service)
        }
        "CreateNexusEndpoint" => {
            rpc_call!(connection, call, create_nexus_endpoint, operator_service)
        }
        "DeleteNamespace" => {
            rpc_call!(connection, call, delete_namespace, operator_service)
        }
        "DeleteNexusEndpoint" => {
            rpc_call!(connection, call, delete_nexus_endpoint, operator_service)
        }
        "GetNexusEndpoint" => rpc_call!(connection, call, get_nexus_endpoint, operator_service),
        "ListClusters" => rpc_call!(connection, call, list_clusters, operator_service),
        "ListNexusEndpoints" => rpc_call!(connection, call, list_nexus_endpoints, operator_service),
        "ListSearchAttributes" => {
            rpc_call!(connection, call, list_search_attributes, operator_service)
        }
        "RemoveRemoteCluster" => {
            rpc_call!(connection, call, remove_remote_cluster, operator_service)
        }
        "RemoveSearchAttributes" => {
            rpc_call!(connection, call, remove_search_attributes, operator_service)
        }
        "UpdateNexusEndpoint" => {
            rpc_call!(connection, call, update_nexus_endpoint, operator_service)
        }
        _ => Err(BridgeError::TypeError {
            field: None,
            message: format!("Unknown RPC call {}", call.rpc),
        }),
    }
}

async fn client_invoke_test_service(
    mut connection: Connection,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporalio_client::grpc::TestService;

    match call.rpc.as_str() {
        "GetCurrentTime" => rpc_call!(connection, call, get_current_time, test_service),
        "LockTimeSkipping" => rpc_call!(connection, call, lock_time_skipping, test_service),
        "SleepUntil" => rpc_call!(connection, call, sleep_until, test_service),
        "Sleep" => rpc_call!(connection, call, sleep, test_service),
        "UnlockTimeSkippingWithSleep" => {
            rpc_call!(
                connection,
                call,
                unlock_time_skipping_with_sleep,
                test_service
            )
        }
        "UnlockTimeSkipping" => rpc_call!(connection, call, unlock_time_skipping, test_service),
        _ => Err(BridgeError::TypeError {
            field: None,
            message: format!("Unknown RPC call {}", call.rpc),
        }),
    }
}

async fn client_invoke_health_service(
    mut connection: Connection,
    call: RpcCall,
) -> BridgeResult<Vec<u8>> {
    use temporalio_client::grpc::HealthService;

    match call.rpc.as_str() {
        "Check" => rpc_call!(connection, call, check, health_service),
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
        match v {
            MetadataValue::Ascii { value: v } => {
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
            MetadataValue::Binary { value: v } => {
                req.metadata_mut().insert_bin(
                    MetadataKey::from_str(k.as_str()).map_err(|err| BridgeError::TypeError {
                        field: None,
                        message: format!("Invalid metadata key: {err}"),
                    })?,
                    BinaryMetadataValue::from_bytes(&v),
                );
            }
        }
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
        Err(err) => Err(BridgeError::from(err)),
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use std::collections::HashMap;

    use temporalio_client::{
        ClientTlsOptions as CoreClientTlsOptions, ConnectionOptions, HttpConnectProxyOptions,
        TlsOptions as CoreTlsOptions,
    };
    use temporalio_common::telemetry::metrics::TemporalMeter;
    use temporalio_sdk_core::Url;

    use bridge_macros::TryFromJs;

    use crate::client::MetadataValue;

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct ClientOptions {
        target_url: Url,
        client_name: String,
        client_version: String,
        tls: Option<TlsOptions>,
        http_connect_proxy: Option<HttpConnectProxy>,
        headers: Option<HashMap<String, MetadataValue>>,
        api_key: Option<String>,
        disable_error_code_metric_tags: bool,
    }

    #[derive(Debug, Clone, TryFromJs)]
    #[allow(clippy::struct_field_names)]
    struct TlsOptions {
        domain: Option<String>,
        server_root_ca_cert: Option<Vec<u8>>,
        client_tls_options: Option<TlsOptionsClientCertPair>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct TlsOptionsClientCertPair {
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

    impl ClientOptions {
        pub(super) fn into_connection_options(
            self,
            metrics_meter: Option<TemporalMeter>,
        ) -> ConnectionOptions {
            let (ascii_headers, bin_headers) = partition_headers(self.headers);
            let http_connect_proxy = self.http_connect_proxy.map(Into::into);

            ConnectionOptions::new(self.target_url)
                .client_name(self.client_name)
                .client_version(self.client_version)
                .maybe_tls_options(self.tls.map(Into::into))
                .maybe_http_connect_proxy(http_connect_proxy.clone())
                // DNS load balancing is mutually exclusive with HTTP CONNECT proxy in sdk-core.
                // Disable it when a proxy is configured; otherwise use the default.
                .dns_load_balancing(if http_connect_proxy.is_some() {
                    None
                } else {
                    Some(temporalio_client::DnsLoadBalancingOptions::default())
                })
                .maybe_headers(ascii_headers)
                .maybe_binary_headers(bin_headers)
                .maybe_api_key(self.api_key)
                .maybe_metrics_meter(metrics_meter)
                .disable_error_code_metric_tags(self.disable_error_code_metric_tags)
                // identity -- skipped: will be set on worker
                // retry_config -- skipped: worker overrides anyway
                // override_origin -- skipped: will default to tls_cfg.domain
                // keep_alive -- skipped: defaults to true; is there any reason to disable this?
                // skip_get_system_info -- skipped: defaults to false; is there any reason to set this?
                .build()
        }
    }

    impl From<TlsOptions> for CoreTlsOptions {
        fn from(val: TlsOptions) -> Self {
            Self {
                domain: val.domain,
                server_root_ca_cert: val.server_root_ca_cert,
                client_tls_options: val.client_tls_options.map(|pair| CoreClientTlsOptions {
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

    #[allow(clippy::type_complexity)]
    pub(super) fn partition_headers(
        headers: Option<HashMap<String, MetadataValue>>,
    ) -> (
        Option<HashMap<String, String>>,
        Option<HashMap<String, Vec<u8>>>,
    ) {
        let Some(headers) = headers else {
            return (None, None);
        };
        let mut ascii_headers = HashMap::default();
        let mut bin_headers = HashMap::default();
        for (k, v) in headers {
            match v {
                MetadataValue::Ascii { value: v } => {
                    ascii_headers.insert(k, v);
                }
                MetadataValue::Binary { value: v } => {
                    bin_headers.insert(k, v);
                }
            }
        }
        (
            (!ascii_headers.is_empty()).then_some(ascii_headers),
            (!bin_headers.is_empty()).then_some(bin_headers),
        )
    }
}
