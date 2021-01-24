mod mock_core;

use neon::prelude::*;

use ::temporal_sdk_core::protos::coresdk::poll_sdk_task_resp::Task::WfTask;
use ::temporal_sdk_core::protos::coresdk::*;
use ::temporal_sdk_core::protos::temporal::api::taskqueue::v1::TaskQueue;
use neon::{declare_types, register_module};

pub struct Worker {
    queue_name: String,
    core: mock_core::MockCore,
}

declare_types! {
    pub class JsWorker for Worker {
        init(mut cx) {
            let mut tasks = ::std::collections::VecDeque::<poll_sdk_task_resp::Task>::new();
            tasks.push_back(
                WfTask(
                    SdkwfTask{
                        r#type: WfTaskType::StartWorkflow as i32,
                        timestamp: None,
                        attributes: Some(
                            sdkwf_task::Attributes::StartWorkflowTaskAttributes(
                                StartWorkflowTaskAttributes {
                                    namespace: "default".to_string(),
                                    name: "main".to_string(),
                                    arguments: None
                                }
                            )
                        )
                    }
                )
            );
            tasks.push_back(
                WfTask(
                    SdkwfTask{
                        r#type: WfTaskType::CompleteTimer as i32,
                        timestamp: None,
                        attributes: Some(
                            sdkwf_task::Attributes::CompleteTimerTaskAttributes(
                                CompleteTimerTaskAttributes {
                                    timer_id: 0,
                                }
                            )
                        )
                    }
                )
            );
            let queue_name: Handle<JsString> = cx.argument::<JsString>(0)?;
            let core = mock_core::MockCore{ tasks };

            Ok(Worker {
                queue_name: queue_name.value(),
                core,
            })
        }

        method poll(mut cx) {
            let callback: Handle<JsFunction> = cx.argument::<JsFunction>(0)?;
            let mut this = cx.this();
            let (core, queue_name) = {
                let guard = cx.lock();
                let mut borrowed = this.borrow_mut(&guard);
                let core = borrowed.core.clone();
                borrowed.core.tasks.pop_front();
                (core, borrowed.queue_name.clone())
            };
            PollTask{
                core: Box::new(core),
                queue_name,
            }.schedule(callback);
            Ok(cx.undefined().upcast())
        }
    }
}

// Mock task that returns preset responses
struct PollTask {
    core: Box<mock_core::MockCore>,
    queue_name: String,
}

impl Task for PollTask {
    type Output = Option<PollSdkTaskResp>;
    type Error = String;
    type JsEvent = JsObject;

    fn perform(&self) -> Result<Self::Output, Self::Error> {
        match self.core.poll_sdk_task(PollSdkTaskReq {
            task_queues: vec![TaskQueue {
                name: self.queue_name.clone(),
                kind: 0, /* TODO */
            }],
        }) {
            Ok(task) => Ok(Some(task.clone())),
            Err(_error) => Ok(None),
        }
    }

    fn complete(
        self,
        mut cx: TaskContext,
        result: Result<Self::Output, Self::Error>,
    ) -> JsResult<Self::JsEvent> {
        let response_option = match result {
            Ok(output) => output,
            Err(err) => panic!(err.to_string()),
        };
        let obj = cx.empty_object();
        match response_option {
            Some(response) => {
                match std::str::from_utf8(&response.task_token) {
                    Ok(task_token) => {
                        let token = cx.string(task_token);
                        obj.set(&mut cx, "taskToken", token)?;
                    }
                    Err(err) => panic!(err.to_string()),
                };
                match response.task {
                    Some(WfTask(task)) => {
                        let task_type: WfTaskType = unsafe { std::mem::transmute(task.r#type) };
                        let type_str = cx.string(format!("{:?}", task_type));
                        obj.set(&mut cx, "type", type_str)?;
                        match task.attributes {
                            Some(sdkwf_task::Attributes::CompleteTimerTaskAttributes(attrs)) => {
                                let timer_id = cx.number(attrs.timer_id);
                                obj.set(&mut cx, "taskSeq", timer_id)?;
                            }
                            _ => {}
                        };
                    }
                    _ => panic!("Failed to extract type from task"),
                };
            }
            _ => {}
        }
        Ok(obj)
    }
}

register_module!(mut cx, { cx.export_class::<JsWorker>("Worker") });
