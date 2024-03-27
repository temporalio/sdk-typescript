mod conversions;
mod errors;
mod helpers;
mod runtime;
mod testing;
mod worker;

use crate::runtime::*;
use crate::worker::*;
use neon::prelude::*;
use testing::*;

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("getTimeOfDay", get_time_of_day)?;
    cx.export_function("newRuntime", runtime_new)?;
    cx.export_function("newClient", client_new)?;
    cx.export_function("clientUpdateHeaders", client_update_headers)?;
    cx.export_function("clientUpdateApiKey", client_update_api_key)?;
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("newReplayWorker", replay_worker_new)?;
    cx.export_function("pushHistory", push_history)?;
    cx.export_function("closeHistoryStream", close_history_stream)?;
    cx.export_function("workerInitiateShutdown", worker_initiate_shutdown)?;
    cx.export_function("workerFinalizeShutdown", worker_finalize_shutdown)?;
    cx.export_function("clientClose", client_close)?;
    cx.export_function("runtimeShutdown", runtime_shutdown)?;
    cx.export_function("pollLogs", poll_logs)?;
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
    cx.export_function("startEphemeralServer", start_ephemeral_server)?;
    cx.export_function("shutdownEphemeralServer", shutdown_ephemeral_server)?;
    cx.export_function("getEphemeralServerTarget", get_ephemeral_server_target)?;
    Ok(())
}
