use neon::{prelude::*, register_module};
use prost::Message;
use std::{
    convert::TryInto,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use temporal_sdk_core::{
    init,
    protos::coresdk::{self, TaskCompletion},
    Core, CoreInitOptions, ServerGatewayOptions,
};

type BoxedWorker = JsBox<Arc<Worker>>;

pub struct Worker {
    queue_name: String,
    core: Box<dyn Core + Send + Sync>,
    condition: Condvar,
    suspended: Mutex<bool>,
}

impl Finalize for Worker {}

impl Worker {
    pub fn new(queue_name: String) -> Self {
        let core = init(CoreInitOptions {
            gateway_opts: ServerGatewayOptions {
                target_url: "http://localhost:7233".try_into().unwrap(),
                namespace: "default".to_string(),
                identity: "node_sdk_test".to_string(),
                worker_binary_id: "".to_string(),
                long_poll_timeout: Duration::from_secs(30),
            },
        })
        .unwrap();

        Worker {
            queue_name,
            core: Box::new(core),
            condition: Condvar::new(),
            suspended: Mutex::new(false),
        }
    }

    pub fn poll(&self) -> ::temporal_sdk_core::Result<coresdk::Task> {
        let _guard = self
            .condition
            .wait_while(self.suspended.lock().unwrap(), |suspended| *suspended)
            .unwrap();
        self.core.poll_task(&self.queue_name)
    }

    pub fn is_suspended(&self) -> bool {
        *self.suspended.lock().unwrap()
    }

    pub fn suspend_polling(&self) {
        *self.suspended.lock().unwrap() = true;
        self.condition.notify_one();
    }

    pub fn resume_polling(&self) {
        *self.suspended.lock().unwrap() = false;
        self.condition.notify_one();
    }
}

fn worker_new(mut cx: FunctionContext) -> JsResult<BoxedWorker> {
    let queue_name = cx.argument::<JsString>(0)?.value(&mut cx);
    let worker = Arc::new(Worker::new(queue_name));

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
        let worker = arc_worker;
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
        TaskCompletion::decode_length_delimited(data.as_slice::<u8>())
    });
    match result {
        Ok(completion) => {
            // TODO: submit from background thread (using neon::Task)?
            if let Err(err) = worker.core.complete_task(completion) {
                let error = JsError::error(&mut cx, format!("{}", err))?;
                cx.throw(error)
            } else {
                Ok(cx.undefined())
            }
        }
        Err(_) => cx.throw_type_error("Cannot decode Completion from buffer"),
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
    worker.suspend_polling();
    Ok(cx.undefined())
}

fn worker_resume_polling(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    worker.resume_polling();
    Ok(cx.undefined())
}

fn worker_is_suspended(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    Ok(cx.boolean(worker.is_suspended()))
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
