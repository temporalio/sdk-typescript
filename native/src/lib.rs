use neon::prelude::*;
use neon::{declare_types, register_module};
use temporal_sdk_core::protos::coresdk::poll_sdk_task_resp::Task::WfTask;
use temporal_sdk_core::protos::coresdk::*;

pub struct Worker {
    _queue_name: String,
}

declare_types! {
    pub class JsWorker for Worker {
        init(mut cx) {
            let queue_name: Handle<JsString> = cx.argument::<JsString>(0)?;

            Ok(Worker {
                _queue_name: queue_name.value(),
            })
        }

        method poll(mut cx) {
            let callback: Handle<JsFunction> = cx.argument::<JsFunction>(0)?;
            PollTask{
                response: PollSdkTaskResp {
                    task_token: b"abc".to_vec(),
                    task: Some(WfTask(SdkwfTask { original: None })),
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
    type Output = i32;
    type Error = String;
    type JsEvent = JsObject;

    fn perform(&self) -> Result<Self::Output, Self::Error> {
        Ok(0)
    }

    fn complete(
        self,
        mut cx: TaskContext,
        _result: Result<Self::Output, Self::Error>,
    ) -> JsResult<Self::JsEvent> {
        let obj = cx.empty_object();
        match std::str::from_utf8(&self.response.task_token) {
            Ok(task_token) => {
                let str = cx.string(task_token);
                obj.set(&mut cx, "token", str)?;
            }
            Err(err) => panic!(err.to_string()),
        };
        Ok(obj)
    }
}

register_module!(mut cx, { cx.export_class::<JsWorker>("Worker") });
