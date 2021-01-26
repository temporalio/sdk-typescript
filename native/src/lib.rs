mod mock_core;

use ::neon::prelude::*;
use ::neon::register_module;
use ::std::cell::RefCell;
use ::temporal_sdk_core::protos::coresdk::poll_sdk_task_resp::Task::WfTask;
use ::temporal_sdk_core::protos::coresdk::PollSdkTaskResp;
use ::temporal_sdk_core::protos::coresdk::*;

type BoxedWorker = JsBox<RefCell<Worker>>;

#[derive(Clone)]
pub struct Worker {
    _queue_name: String,
    core: mock_core::MockCore,
}

impl Finalize for Worker {}

impl Worker {
    pub fn new(queue_name: String) -> Self {
        let mut tasks = ::std::collections::VecDeque::<poll_sdk_task_resp::Task>::new();
        tasks.push_back(WfTask(SdkwfTask {
            r#type: WfTaskType::StartWorkflow as i32,
            workflow_id: "test".to_string(),
            timestamp: None,
            attributes: Some(sdkwf_task::Attributes::StartWorkflowTaskAttributes(
                StartWorkflowTaskAttributes {
                    namespace: "default".to_string(),
                    name: "main".to_string(),
                    arguments: None,
                },
            )),
        }));
        tasks.push_back(WfTask(SdkwfTask {
            r#type: WfTaskType::CompleteTimer as i32,
            workflow_id: "test".to_string(),
            timestamp: None,
            attributes: Some(sdkwf_task::Attributes::CompleteTimerTaskAttributes(
                CompleteTimerTaskAttributes { timer_id: 0 },
            )),
        }));
        let core = mock_core::MockCore { tasks };

        Worker {
            _queue_name: queue_name,
            core,
        }
    }

    pub fn poll(&mut self) -> ::temporal_sdk_core::Result<PollSdkTaskResp> {
        let res = self.core.poll_sdk_task();
        self.core.tasks.pop_front();
        res
    }
}

fn worker_new(mut cx: FunctionContext) -> JsResult<BoxedWorker> {
    let queue_name = cx.argument::<JsString>(0)?.value(&mut cx);
    let worker = RefCell::new(Worker::new(queue_name));

    Ok(cx.boxed(worker))
}

fn worker_poll(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?.root(&mut cx);
    let mut worker = worker.borrow_mut().clone();
    let arc_callback = ::std::sync::Arc::new(callback);
    let queue = cx.queue();
    std::thread::spawn(move || loop {
        let arc_callback = arc_callback.clone();
        let response_option = worker.poll();
        match response_option {
            Ok(response) => {
                queue.send(move |mut cx| {
                    let raw_callback = ::std::sync::Arc::into_raw(arc_callback);
                    if let Some(r) = unsafe { raw_callback.as_ref() } {
                        let callback = r.clone(&mut cx).into_inner(&mut cx);
                        let this = cx.undefined();
                        let error = cx.undefined();
                        let result = poll_sdk_task_resp_to_js_object(&mut cx, &response)?;
                        let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                        callback.call(&mut cx, this, args)?;
                    };
                    Ok(())
                });
            }
            Err(_) => {
                queue.send(move |mut cx| {
                    let raw_callback = ::std::sync::Arc::into_raw(arc_callback);
                    if let Some(r) = unsafe { raw_callback.as_ref() } {
                        let callback = r.clone(&mut cx).into_inner(&mut cx);
                        let this = cx.undefined();
                        // For mock core this signals end of tasks
                        let error = JsError::error(&mut cx, "EOF")?;
                        let result = cx.undefined();
                        let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                        callback.call(&mut cx, this, args)?;
                    }
                    // TODO:
                    // if let Some(r) = unsafe { raw_callback.as_ref() } {
                    //     r.drop(&mut cx);
                    // };
                    Ok(())
                });
                break;
            }
        }
    });
    Ok(cx.undefined())
}

fn poll_sdk_task_resp_to_js_object<'a, 'b>(
    cx: &mut TaskContext<'a>,
    response: &'b PollSdkTaskResp,
) -> JsResult<'a, JsObject> {
    let result = cx.empty_object();
    match std::str::from_utf8(&response.task_token) {
        Ok(task_token) => {
            let token = cx.string(task_token);
            result.set(cx, "taskToken", token)?;
        }
        Err(err) => panic!(err.to_string()),
    };
    match &response.task {
        Some(WfTask(task)) => {
            let task_type: WfTaskType = unsafe { std::mem::transmute(task.r#type) };
            let type_str = cx.string(format!("{:?}", task_type));
            result.set(cx, "type", type_str)?;
            let workflow_id = cx.string(task.workflow_id.clone());
            result.set(cx, "workflowID", workflow_id)?;
            match &task.attributes {
                Some(sdkwf_task::Attributes::CompleteTimerTaskAttributes(attrs)) => {
                    let timer_id = cx.number(attrs.timer_id);
                    result.set(cx, "taskSeq", timer_id)?;
                }
                Some(sdkwf_task::Attributes::StartWorkflowTaskAttributes(attrs)) => {
                    let namespace = cx.string(attrs.namespace.clone());
                    result.set(cx, "namespace", namespace)?;
                    let name = cx.string(attrs.name.clone());
                    result.set(cx, "name", name)?;
                }
                _ => {}
            };
        }
        _ => panic!("Failed to extract type from task"),
    };
    Ok(result)
}

register_module!(mut cx, {
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("workerPoll", worker_poll)?;
    Ok(())
});
