mod mock_core;

use ::neon::prelude::*;
use ::neon::register_module;
use ::std::sync::{Arc, Condvar, Mutex, RwLock};
use ::temporal_sdk_core::protos::coresdk;
use ::temporal_sdk_core::protos::coresdk::{
    task, workflow_task, StartWorkflowTaskAttributes, TriggerTimerTaskAttributes, WorkflowTask,
};
use ::temporal_sdk_core::Core;

type BoxedWorker = JsBox<Arc<RwLock<Worker>>>;

pub struct Worker {
    _queue_name: String,
    core: mock_core::MockCore,
    condition: Condvar,
    suspended: Mutex<bool>,
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
            condition: Condvar::new(),
            suspended: Mutex::new(false),
        }
    }

    pub fn poll(&mut self) -> ::temporal_sdk_core::Result<coresdk::Task> {
        let _guard = self
            .condition
            .wait_while(self.suspended.lock().unwrap(), |suspended| *suspended)
            .unwrap();
        let res = self.core.poll_task();
        self.core.tasks.pop_front();
        res
    }

    pub fn is_suspended(&self) -> bool {
        *self.suspended.lock().unwrap()
    }

    pub fn suspend_polling(&self) {
        *self.suspended.lock().unwrap() = true;
    }

    pub fn resume_polling(&self) {
        *self.suspended.lock().unwrap() = false;
    }
}

fn worker_new(mut cx: FunctionContext) -> JsResult<BoxedWorker> {
    let queue_name = cx.argument::<JsString>(0)?.value(&mut cx);
    let worker = Arc::new(RwLock::new(Worker::new(queue_name)));

    Ok(cx.boxed(worker))
}

fn worker_poll(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let callback = cx.argument::<JsFunction>(1)?.root(&mut cx);
    let worker = Arc::clone(&**worker); // deref Handle and JsBox
    let arc_callback = Arc::new(callback);
    let queue = cx.queue();
    std::thread::spawn(move || loop {
        let arc_callback = arc_callback.clone();
        let worker = worker.clone();
        let worker = &mut worker.write().unwrap();
        let result = worker.poll();
        match result {
            Ok(task) => {
                queue.send(move |mut cx| {
                    let r = &*arc_callback;
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
                    if let Ok(r) = Arc::try_unwrap(arc_callback) {
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

fn worker_suspend_polling(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let w = &mut worker.write().unwrap();
    w.suspend_polling();
    Ok(cx.undefined())
}

fn worker_resume_polling(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let w = &mut worker.write().unwrap();
    w.resume_polling();
    Ok(cx.undefined())
}

fn worker_is_suspended(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let w = &mut worker.read().unwrap();
    Ok(cx.boolean(w.is_suspended()))
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
    cx.export_function("workerSuspendPolling", worker_suspend_polling)?;
    cx.export_function("workerResumePolling", worker_resume_polling)?;
    cx.export_function("workerIsSuspended", worker_is_suspended)?;
    Ok(())
});
