mod mock_core;

use ::neon::prelude::*;
use ::neon::register_module;
use ::std::cell::RefCell;
use ::temporal_sdk_core::protos::coresdk;
use ::temporal_sdk_core::protos::coresdk::{
    task, workflow_task, StartWorkflowTaskAttributes, TriggerTimerTaskAttributes, WorkflowTask,
};
use ::temporal_sdk_core::Core;

type BoxedWorker = JsBox<RefCell<Worker>>;

#[derive(Clone)]
pub struct Worker {
    _queue_name: String,
    core: mock_core::MockCore,
}

impl Finalize for Worker {}

impl Worker {
    pub fn new(queue_name: String) -> Self {
        let mut tasks = ::std::collections::VecDeque::<task::Variant>::new();
        tasks.push_back(task::Variant::Workflow(WorkflowTask {
            workflow_id: "test".to_string(),
            timestamp: None,
            attributes: Some(workflow_task::Attributes::StartWorkflow(
                StartWorkflowTaskAttributes {
                    namespace: "default".to_string(),
                    name: "main".to_string(),
                    arguments: None,
                },
            )),
        }));
        tasks.push_back(task::Variant::Workflow(WorkflowTask {
            workflow_id: "test".to_string(),
            timestamp: None,
            attributes: Some(workflow_task::Attributes::TriggerTimer(
                TriggerTimerTaskAttributes {
                    timer_id: "0".to_string(),
                },
            )),
        }));
        let core = mock_core::MockCore { tasks };

        Worker {
            _queue_name: queue_name,
            core,
        }
    }

    pub fn poll(&mut self) -> ::temporal_sdk_core::Result<coresdk::Task> {
        let res = self.core.poll_task();
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
        match worker.poll() {
            Ok(task) => {
                queue.send(move |mut cx| {
                    // TODO: figure out how to do this safely, for some reason try_unwrap returns
                    // Err here
                    let r = unsafe { &*::std::sync::Arc::into_raw(arc_callback) };
                    let callback = r.clone(&mut cx).into_inner(&mut cx);
                    let this = cx.undefined();
                    let error = cx.undefined();
                    let result = task_to_js_object(&mut cx, &task)?;
                    let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                    callback.call(&mut cx, this, args)?;
                    Ok(())
                });
            }
            Err(err) => {
                queue.send(move |mut cx| {
                    if let Ok(r) = ::std::sync::Arc::try_unwrap(arc_callback) {
                        println!("unwrapped on err");
                        // Original root callback gets dropped
                        let callback = r.into_inner(&mut cx);
                        let this = cx.undefined();
                        let error = JsError::error(&mut cx, format!("{}", err))?;
                        let result = cx.undefined();
                        let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                        callback.call(&mut cx, this, args)?;
                    }
                    Ok(())
                });
                break;
            }
        }
    });
    Ok(cx.undefined())
}

fn task_to_js_object<'a, 'b>(
    cx: &mut TaskContext<'a>,
    task: &'b coresdk::Task,
) -> JsResult<'a, JsObject> {
    let result = cx.empty_object();
    match std::str::from_utf8(&task.task_token) {
        Ok(task_token) => {
            let token = cx.string(task_token);
            result.set(cx, "taskToken", token)?;
        }
        Err(err) => panic!(err.to_string()),
    };
    match &task.variant {
        Some(task::Variant::Workflow(task)) => {
            if let Some(attributes) = &task.attributes {
                let workflow_id = cx.string(task.workflow_id.clone());
                result.set(cx, "workflowID", workflow_id)?;
                match &attributes {
                    workflow_task::Attributes::TriggerTimer(attrs) => {
                        let task_type = cx.string("TriggerTimer".to_string());
                        result.set(cx, "type", task_type)?;
                        if let Ok(timer_id) = attrs.timer_id.parse::<f32>() {
                            let task_seq = cx.number(timer_id);
                            result.set(cx, "taskSeq", task_seq)?;
                        }; // TODO handle cast error
                    }
                    workflow_task::Attributes::StartWorkflow(attrs) => {
                        let task_type = cx.string("StartWorkflow".to_string());
                        result.set(cx, "type", task_type)?;
                        let namespace = cx.string(attrs.namespace.clone());
                        result.set(cx, "namespace", namespace)?;
                        let name = cx.string(attrs.name.clone());
                        result.set(cx, "name", name)?;
                        // TODO: arguments
                    }
                };
            }
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
