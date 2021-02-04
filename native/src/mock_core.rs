use ::temporal_sdk_core::protos::coresdk::{
    complete_task_req, task, wf_activation_completion, CompleteTaskReq, Task,
};
use ::temporal_sdk_core::{Core, CoreError::NoWork, Result};

#[derive(Clone)]
pub struct MockCore {
    pub tasks: ::std::collections::VecDeque<task::Variant>,
}

impl Core for MockCore {
    fn poll_task(&self, _task_q: &str) -> Result<Task> {
        match self.tasks.get(0) {
            Some(task) => Result::Ok(Task {
                task_token: b"abc".to_vec(),
                variant: Some(task.clone()),
            }),
            _ => Result::Err(NoWork {}),
        }
    }

    fn complete_task(&self, req: CompleteTaskReq) -> Result<()> {
        match req.completion {
            Some(complete_task_req::Completion::Workflow(wf)) => {
                match wf.status {
                    Some(wf_activation_completion::Status::Successful(success)) => {
                        println!("WF task success: {:#?}", success.commands);
                    }
                    _ => {}
                };
            }
            _ => {}
        };
        Result::Ok(())
    }
}
