use std::{
    collections::VecDeque,
    sync::{Arc, RwLock},
};
use temporal_sdk_core::{
    protos::coresdk::{complete_task_req, task, wf_activation_completion, CompleteTaskReq, Task},
    Core,
    CoreError::NoWork,
    Result, ServerGatewayApis,
};

#[derive(Clone)]
pub struct MockCore {
    tasks: Arc<RwLock<VecDeque<task::Variant>>>,
}

impl MockCore {
    pub fn new(tasks: VecDeque<task::Variant>) -> Self {
        Self {
            tasks: Arc::new(RwLock::new(tasks)),
        }
    }
}

impl Core for MockCore {
    fn poll_task(&self, _task_q: &str) -> Result<Task> {
        match self
            .tasks
            .write()
            .expect("Mock queue must be writeable")
            .pop_front()
        {
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

    fn server_gateway(&self) -> Result<Arc<dyn ServerGatewayApis>> {
        unimplemented!()
    }
}
