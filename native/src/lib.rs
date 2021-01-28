mod mock_core;

use ::neon::prelude::*;
use ::neon::register_module;
use ::prost_types::{Duration, Timestamp};
use ::std::sync::{Arc, Condvar, Mutex, RwLock};
use ::temporal_sdk_core::protos::coresdk;
use ::temporal_sdk_core::protos::coresdk::{
    command::Variant as CommandVariant, complete_task_req, task, workflow_task,
    workflow_task_completion, ActivityTaskCompletion, Command, CompleteTaskReq,
    StartWorkflowTaskAttributes, TriggerTimerTaskAttributes, WorkflowTask, WorkflowTaskCompletion,
    WorkflowTaskSuccess,
};
use ::temporal_sdk_core::protos::temporal::api::command::v1::{
    command::Attributes as CommandAttributes, Command as ApiCommand,
    CompleteWorkflowExecutionCommandAttributes, StartTimerCommandAttributes,
};
use ::temporal_sdk_core::protos::temporal::api::enums::v1::CommandType;

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
            timestamp: Some(Timestamp::from(::std::time::SystemTime::now())),
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
            timestamp: Some(Timestamp::from(::std::time::SystemTime::now())),
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

fn worker_complete_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let completion = cx.argument::<JsObject>(1)?;
    let completion = completion_from_js_object(&mut cx, completion)?;
    let w = &mut worker.read().unwrap();
    if let Err(err) = w.core.complete_task(completion) {
        let error = JsError::error(&mut cx, format!("{}", err))?;
        cx.throw(error)
    } else {
        Ok(cx.undefined())
    }
}

fn completion_from_js_object(
    cx: &mut FunctionContext,
    completion: Handle<JsObject>,
) -> NeonResult<CompleteTaskReq> {
    let task_token: Handle<JsString> = completion.get(cx, "taskToken")?.downcast_or_throw(cx)?;
    let task_token = task_token.value(cx).as_bytes().to_vec();

    let completion_type: Handle<JsString> = completion
        .get(cx, "completionType")?
        .downcast_or_throw(cx)?;
    let completion = match completion_type.value(cx).as_ref() {
        "workflow" => {
            let status: Option<workflow_task_completion::Status> = match completion.get(cx, "ok") {
                Ok(obj) => {
                    let obj: Handle<JsObject> = obj.downcast_or_throw(cx)?;
                    let js_commands: Handle<JsArray> =
                        obj.get(cx, "commands")?.downcast_or_throw(cx)?;
                    let len = js_commands.len(cx);
                    let mut commands: Vec<Command> = Vec::with_capacity(len as usize);
                    for i in 0..len {
                        let js_command: Handle<JsObject> =
                            js_commands.get(cx, i)?.downcast_or_throw(cx)?;
                        let command_type: Handle<JsString> =
                            js_command.get(cx, "type")?.downcast_or_throw(cx)?;
                        let (command_type, attributes) = match command_type.value(cx).as_ref() {
                            "StartTimer" => {
                                let task_seq: Handle<JsNumber> =
                                    js_command.get(cx, "seq")?.downcast_or_throw(cx)?;
                                let ms: Handle<JsNumber> =
                                    js_command.get(cx, "ms")?.downcast_or_throw(cx)?;
                                let attributes =
                                    Some(CommandAttributes::StartTimerCommandAttributes(
                                        StartTimerCommandAttributes {
                                            timer_id: task_seq.value(cx).to_string(),
                                            start_to_fire_timeout: Some(Duration::from(
                                                ::std::time::Duration::from_millis(
                                                    ms.value(cx) as u64
                                                ),
                                            )),
                                        },
                                    ));
                                (CommandType::StartTimer, attributes)
                            }
                            "CompleteWorkflow" => {
                                // TODO: get result
                                let attributes = Some(
                                    CommandAttributes::CompleteWorkflowExecutionCommandAttributes(
                                        CompleteWorkflowExecutionCommandAttributes { result: None },
                                    ),
                                );
                                (CommandType::CompleteWorkflowExecution, attributes)
                            }
                            _ => panic!("Invalid command type"),
                        };
                        let command = Command {
                            variant: Some(CommandVariant::Api(ApiCommand {
                                command_type: command_type as i32,
                                attributes,
                            })),
                        };
                        commands.push(command);
                    }
                    Some(workflow_task_completion::Status::Successful(
                        WorkflowTaskSuccess { commands },
                    ))
                }
                _ => None, // TODO
            };
            complete_task_req::Completion::Workflow(WorkflowTaskCompletion { status })
        }
        "activity" => {
            complete_task_req::Completion::Activity(ActivityTaskCompletion { status: None })
        }
        _ => panic!("Invalid completionType"),
    };

    Ok(CompleteTaskReq {
        task_token,
        completion: Some(completion),
    })
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
            match &task.timestamp {
                Some(timestamp) => {
                    match ::std::time::SystemTime::from(timestamp.clone())
                        .duration_since(::std::time::UNIX_EPOCH)
                    {
                        Ok(time_since_epoch) => {
                            let timestamp = cx.number(time_since_epoch.as_millis() as f64);
                            result.set(cx, "timestamp", timestamp)?;
                        }
                        _ => panic!("Failed to timestamp from task"),
                    }
                }
                _ => panic!("Failed to timestamp from task"),
            }
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
    cx.export_function("workerCompleteTask", worker_complete_task)?;
    cx.export_function("workerSuspendPolling", worker_suspend_polling)?;
    cx.export_function("workerResumePolling", worker_resume_polling)?;
    cx.export_function("workerIsSuspended", worker_is_suspended)?;
    Ok(())
});
