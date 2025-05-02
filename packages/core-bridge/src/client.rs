use crate::{conversions::ObjectHandleConversionsExt, helpers::*, runtime::*};
use neon::prelude::*;
use prost::DecodeError;
use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;
use std::{cell::RefCell, sync::Arc};
use temporal_client::{
    ConfiguredClient, RetryClient, TemporalServiceClientWithMetrics, WorkflowService,
};
use tonic::metadata::MetadataKey;

#[derive(Clone)]
pub struct Client {
    pub(crate) runtime: Arc<RuntimeHandle>,
    pub(crate) core_client: Arc<CoreClient>,
}

pub type CoreClient = RetryClient<ConfiguredClient<TemporalServiceClientWithMetrics>>;

pub(crate) type BoxedClient = JsBox<RefCell<Option<Client>>>;
impl Finalize for Client {}

#[derive(Debug)]
pub struct RpcCall {
    pub rpc: String,
    pub req: Vec<u8>,
    pub retry: bool,
    pub metadata: HashMap<String, String>,
    pub timeout_millis: Option<u64>,
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

#[derive(Debug)]
pub enum RpcError {
    Decode(DecodeError),
    Tonic(tonic::Status),
    Type(String),
}

fn rpc_req<P: prost::Message + Default>(call: RpcCall) -> Result<tonic::Request<P>, RpcError> {
    let proto = P::decode(&*call.req).map_err(RpcError::Decode)?;
    let mut req = tonic::Request::new(proto);
    for (k, v) in call.metadata {
        req.metadata_mut().insert(
            MetadataKey::from_str(k.as_str())
                .map_err(|err| RpcError::Type(format!("Invalid metadata key: {}", err)))?,
            v.parse()
                .map_err(|err| RpcError::Type(format!("Invalid metadata value: {}", err)))?,
        );
    }
    if let Some(timeout_millis) = call.timeout_millis {
        req.set_timeout(Duration::from_millis(timeout_millis));
    }
    Ok(req)
}

fn rpc_resp<P>(res: Result<tonic::Response<P>, tonic::Status>) -> Result<Vec<u8>, RpcError>
where
    P: prost::Message,
    P: Default,
{
    match res {
        Ok(resp) => Ok(resp.get_ref().encode_to_vec()),
        Err(err) => Err(RpcError::Tonic(err)),
    }
}

/// Update a Client's HTTP request headers
pub fn client_update_headers(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let headers = cx
        .argument::<JsObject>(1)?
        .as_hash_map_of_string_to_string(&mut cx)?;
    let callback = cx.argument::<JsFunction>(2)?;

    match client.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Client")?;
        }
        Some(client) => {
            let request = RuntimeRequest::UpdateClientHeaders {
                client: client.core_client.clone(),
                headers,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = client.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
    }

    Ok(cx.undefined())
}

/// Update a Client's API key
pub fn client_update_api_key(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let key = cx.argument::<JsString>(1)?.value(&mut cx);
    let callback = cx.argument::<JsFunction>(2)?;

    match client.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Client")?;
        }
        Some(client) => {
            let request = RuntimeRequest::UpdateClientApiKey {
                client: client.core_client.clone(),
                key,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = client.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
    }

    Ok(cx.undefined())
}

/// Send a request using the provided Client
pub fn client_send_request(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClient>(0)?;
    let call = cx.argument::<JsObject>(1)?;
    let callback = cx.argument::<JsFunction>(2)?;

    match client.borrow().as_ref() {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed Client")?;
        }
        Some(client) => {
            let call = call.as_rpc_call(&mut cx)?;
            let request = RuntimeRequest::SendClientRequest {
                client: client.core_client.clone(),
                call,
                callback: callback.root(&mut cx),
            };
            if let Err(err) = client.runtime.sender.send(request) {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
    }

    Ok(cx.undefined())
}

pub async fn client_invoke(
    mut retry_client: CoreClient,
    call: RpcCall,
) -> Result<Vec<u8>, RpcError> {
    match call.rpc.as_str() {
        "CountWorkflowExecutions" => {
            rpc_call!(retry_client, call, count_workflow_executions)
        }
        "CreateSchedule" => {
            rpc_call!(retry_client, call, create_schedule)
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
        "ExecuteMultiOperation" => rpc_call!(retry_client, call, execute_multi_operation),
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
        "ListWorkflowExecutions" => {
            rpc_call!(retry_client, call, list_workflow_executions)
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
        "UpdateWorkerDeploymentVersionMetadata" => {
            rpc_call!(
                retry_client,
                call,
                update_worker_deployment_version_metadata
            )
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
        _ => Err(RpcError::Type(format!("Unknown RPC call {}", call.rpc))),
    }
}
