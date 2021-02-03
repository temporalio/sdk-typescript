mod mock_core;

use neon::prelude::*;
use neon::register_module;
use prost::Message;
use prost_types::Timestamp;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use temporal_sdk_core::protos::coresdk::{
    self, task, wf_activation_job, CompleteTaskReq, StartWorkflowTaskAttributes,
    TimerFiredTaskAttributes, WfActivation,
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
        tasks.push_back(task::Variant::Workflow(WfActivation {
            run_id: "test".to_string(),
            timestamp: Some(Timestamp::from(::std::time::SystemTime::now())),
            jobs: vec![
                wf_activation_job::Attributes::StartWorkflow(StartWorkflowTaskAttributes {
                    arguments: None,
                    workflow_type: "set-timeout".to_string(),
                    workflow_id: "test".to_string(),
                })
                .into(),
            ],
        }));
        tasks.push_back(task::Variant::Workflow(WfActivation {
            run_id: "test".to_string(),
            timestamp: Some(Timestamp::from(::std::time::SystemTime::now())),
            jobs: vec![
                wf_activation_job::Attributes::TimerFired(TimerFiredTaskAttributes {
                    timer_id: "0".to_string(),
                })
                .into(),
            ],
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
    let arc_worker = Arc::clone(&**worker); // deref Handle and JsBox
    let arc_callback = Arc::new(callback);
    let queue = cx.queue();
    std::thread::spawn(move || loop {
        let arc_callback = arc_callback.clone();
        let arc_worker = arc_worker.clone();
        let worker = &mut arc_worker.write().unwrap();
        let result = worker.poll();
        match result {
            Ok(task) => {
                queue.send(move |mut cx| {
                    let r = &*arc_callback;
                    let callback = r.clone(&mut cx).into_inner(&mut cx);
                    let this = cx.undefined();
                    let error = cx.undefined();
                    let len = task.encoded_len();
                    let mut result = JsArrayBuffer::new(&mut cx, len as u32)?;
                    cx.borrow_mut(&mut result, |data| {
                        let mut slice = data.as_mut_slice::<u8>();
                        if let Err(_) = task.encode(&mut slice) {
                            panic!("Failed to encode task")
                        };
                    });
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

fn worker_complete_task(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let completion = cx.argument::<JsArrayBuffer>(1)?;
    let result = cx.borrow(&completion, |data| {
        CompleteTaskReq::decode_length_delimited(data.as_slice::<u8>())
    });
    match result {
        Ok(completion) => {
            let w = &mut worker.read().unwrap();
            // TODO: submit from background thread (using neon::Task)?
            if let Err(err) = w.core.complete_task(completion) {
                let error = JsError::error(&mut cx, format!("{}", err))?;
                cx.throw(error)
            } else {
                Ok(cx.undefined())
            }
        }
        Err(_) => cx.throw_type_error("Cannot decode CompleteTaskReq from buffer"),
    }
}

fn worker_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    // TODO:
    // let worker = cx.argument::<BoxedWorker>(0)?;
    // let w = &mut worker.read().unwrap();
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

register_module!(mut cx, {
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("workerShutdown", worker_shutdown)?;
    cx.export_function("workerPoll", worker_poll)?;
    cx.export_function("workerCompleteTask", worker_complete_task)?;
    cx.export_function("workerSuspendPolling", worker_suspend_polling)?;
    cx.export_function("workerResumePolling", worker_resume_polling)?;
    cx.export_function("workerIsSuspended", worker_is_suspended)?;
    Ok(())
});
