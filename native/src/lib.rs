mod mock_history;

use neon::prelude::*;

use ::temporal_sdk_core::protos::coresdk::poll_sdk_task_resp::Task::WfTask;
use ::temporal_sdk_core::protos::coresdk::*;
use ::temporal_sdk_core::protos::temporal::api::{
    common::v1::{WorkflowExecution, WorkflowType},
    enums::v1::EventType,
    history::v1::{history_event::Attributes, History, HistoryEvent, TimerFiredEventAttributes},
    taskqueue::v1::TaskQueue,
    workflowservice::v1::*,
};
use neon::{declare_types, register_module};

pub struct Worker {
    queue_name: String,
    history: Vec<Vec<HistoryEvent>>,
    index: usize,
}

declare_types! {
    pub class JsWorker for Worker {
        init(mut cx) {
            let queue_name: Handle<JsString> = cx.argument::<JsString>(0)?;

            let mut history = mock_history::History::default();
            let mut events = Vec::new();
            history.add_by_type(EventType::WorkflowExecutionStarted);
            events.push(history.events.clone());

            history.events.clear();
            history.add_workflow_task();
            events.push(history.events.clone());

            history.events.clear();
            let timer_started_event_id = history.add_get_event_id(EventType::TimerStarted, None);
            history.add(
                EventType::TimerFired,
                Attributes::TimerFiredEventAttributes(TimerFiredEventAttributes {
                    started_event_id: timer_started_event_id,
                    timer_id: "timer1".to_string(),
                    ..Default::default()
                }),
            );
            events.push(history.events.clone());

            history.events.clear();
            history.add_workflow_task();
            events.push(history.events.clone());

            Ok(Worker {
                queue_name: queue_name.value(),
                history: events,
                index: 0,
            })
        }

        method poll(mut cx) {
            let callback: Handle<JsFunction> = cx.argument::<JsFunction>(0)?;
            let mut this = cx.this();
            let (index, events, queue_name) = {
                let guard = cx.lock();
                let mut borrowed = this.borrow_mut(&guard);
                let idx = borrowed.index;
                borrowed.index += 1;
                if (idx >= borrowed.history.len()) {
                    panic!("History is over");
                }
                (idx, borrowed.history[idx].clone(), borrowed.queue_name.clone())
            };
            PollTask{
                response: PollSdkTaskResp{
                    task_token: format!("{}", index).into_bytes(),
                    task: Some(
                        WfTask(SdkwfTask{
                            original: Some(
                                PollWorkflowTaskQueueResponse{
                                    workflow_execution: Some(WorkflowExecution{
                                        workflow_id: "workflow".to_string(),
                                        run_id: "run".to_string(),
                                    }),
                                    workflow_execution_task_queue: Some(TaskQueue{
                                        name: queue_name,
                                        kind: 0,
                                    }),
                                    history: Some(History { events }),
                                    task_token: format!("{}", index).into_bytes(),
                                    ..Default::default()
                                })
                            })),
                },
            }.schedule(callback);
            Ok(cx.undefined().upcast())
        }
    }
}

// Mock task that returns a preset response
struct PollTask {
    response: PollSdkTaskResp,
}

impl Task for PollTask {
    type Output = PollWorkflowTaskQueueResponse;
    type Error = String;
    type JsEvent = JsObject;

    fn perform(&self) -> Result<Self::Output, Self::Error> {
        match &self.response.task {
            Some(task) => match task {
                WfTask(wftask) => match &wftask.original {
                    Some(original) => Ok(original.clone()),
                    _ => Err("No task in response".to_string()),
                },
                _ => Err("No task in response".to_string()),
            },
            _ => Err("No task in response".to_string()),
        }
    }

    fn complete(
        self,
        mut cx: TaskContext,
        result: Result<Self::Output, Self::Error>,
    ) -> JsResult<Self::JsEvent> {
        let response = match result {
            Ok(output) => output,
            Err(err) => panic!(err.to_string()),
        };
        let obj = cx.empty_object();
        match std::str::from_utf8(&response.task_token) {
            Ok(task_token) => {
                let str = cx.string(task_token);
                obj.set(&mut cx, "taskToken", str)?;
            }
            Err(err) => panic!(err.to_string()),
        };
        match response.history {
            Some(history) => {
                let events = JsArray::new(&mut cx, 1);
                for (i, ev) in history.events.iter().enumerate() {
                    let ev_obj = history_event_to_js(&mut cx, &ev)?;
                    events.set(&mut cx, i as u32, ev_obj)?;
                }
                obj.set(&mut cx, "history", events)?;
            }
            None => panic!("No history found in event"),
        };
        Ok(obj)
    }
}

fn history_event_to_js<'a, 'b>(
    cx: &mut TaskContext<'a>,
    ev: &'b HistoryEvent,
) -> JsResult<'a, JsObject> {
    let ev_obj = cx.empty_object();

    let ev_type: EventType = unsafe { std::mem::transmute(ev.event_type) };
    let ev_type_str = cx.string(format!("{:?}", ev_type));
    ev_obj.set(cx, "type", ev_type_str)?;

    let ev_id = cx.number(ev.event_id as f64);
    ev_obj.set(cx, "id", ev_id)?;

    Ok(ev_obj)
}

register_module!(mut cx, { cx.export_class::<JsWorker>("Worker") });
