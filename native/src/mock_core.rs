use ::temporal_sdk_core::protos::coresdk::{task, CompleteTaskReq, RegistrationReq, Task};
use ::temporal_sdk_core::{Core, CoreError::NoWork, Result};

#[derive(Clone)]
pub struct MockCore {
    pub tasks: ::std::collections::VecDeque<task::Variant>,
}

impl Core for MockCore {
    fn poll_task(&self) -> Result<Task> {
        match self.tasks.get(0) {
            Some(task) => Result::Ok(Task {
                task_token: b"abc".to_vec(),
                variant: Some(task.clone()),
            }),
            _ => Result::Err(NoWork {}),
        }
    }

    fn complete_task(&self, req: CompleteTaskReq) -> Result<()> {
        println!("Task complete: {:#?}", req);
        Result::Ok(())
    }

    fn register_implementations(&self, _req: RegistrationReq) -> Result<()> {
        Result::Ok(())
    }
}
