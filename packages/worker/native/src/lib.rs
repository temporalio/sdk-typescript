use neon::{prelude::*, register_module};
use prost::Message;
use std::{
    convert::TryInto,
    sync::{
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc,
    },
    time::Duration,
};
use temporal_sdk_core::{
    init,
    protos::coresdk::{self, TaskCompletion},
    Core, CoreInitOptions, ServerGatewayOptions,
};

type BoxedWorker = JsBox<Arc<Worker>>;

/// A request from lang to poll a queue
pub struct PollRequest {
    /// Name of queue to poll
    queue_name: String,
    /// Used to send the poll result back into lang
    callback: Root<JsFunction>,
}

pub struct Worker {
    core: Box<dyn Core + Send + Sync>,
    sender: SyncSender<PollRequest>,
}

impl Finalize for Worker {}

impl Worker {
    pub fn new() -> (Self, Receiver<PollRequest>) {
        // Set capacity to 1 because we only poll from a single thread
        let (sender, receiver) = sync_channel::<PollRequest>(1);
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

        let worker = Worker {
            core: Box::new(core),
            sender,
        };

        (worker, receiver)
    }

    pub fn poll(&self, queue_name: String) -> ::temporal_sdk_core::Result<coresdk::Task> {
        self.core.poll_task(&queue_name)
    }
}

// Below are functions exported to JS

/// Create a new worker.
/// Immediately spawns a poller thread that will block on [PollRequest]s
fn worker_new(mut cx: FunctionContext) -> JsResult<BoxedWorker> {
    let (worker, receiver) = Worker::new();
    let worker = Arc::new(worker);
    let queue = cx.queue();
    let cloned_worker = Arc::clone(&worker);

    std::thread::spawn(move || loop {
        let item = receiver.recv().unwrap();
        let queue_name = item.queue_name;
        let callback = item.callback;
        let result = worker.poll(queue_name);
        match result {
            Ok(task) => {
                queue.send(move |mut cx| {
                    let callback = callback.into_inner(&mut cx);
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
                // TODO: on the JS side we consider all errors fatal, revise this later
                let should_break = match err {
                    temporal_sdk_core::CoreError::ShuttingDown => true,
                    _ => false,
                };
                queue.send(move |mut cx| {
                    let callback = callback.into_inner(&mut cx);
                    let this = cx.undefined();
                    let error = JsError::error(&mut cx, format!("{}", err))?;
                    let result = cx.undefined();
                    let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
                    callback.call(&mut cx, this, args)?;
                    Ok(())
                });
                if should_break {
                    break;
                }
            }
        }
    });

    Ok(cx.boxed(cloned_worker))
}

/// Initiate a single poll request.
/// Will block if a poll request is already in-flight
fn worker_poll(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    let queue_name = cx.argument::<JsString>(1)?.value(&mut cx);
    let callback = cx.argument::<JsFunction>(2)?.root(&mut cx);
    let item = PollRequest {
        queue_name,
        callback,
    };
    match worker.sender.send(item) {
        Ok(_) => Ok(cx.undefined()),
        Err(err) => {
            let error = JsError::error(&mut cx, format!("{}", err))?;
            cx.throw(error)
        }
    }
}

/// Submit a task completion to core.
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

/// Request shutdown of the worker.
/// Caller should wait until a [CoreError::ShuttingDown] is returned from poll to ensure graceful
/// shutdown.
fn worker_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let worker = cx.argument::<BoxedWorker>(0)?;
    match worker.core.shutdown() {
        Ok(_) => Ok(cx.undefined()),
        Err(err) => {
            let error = JsError::error(&mut cx, format!("{}", err))?;
            cx.throw(error)
        }
    }
}

register_module!(mut cx, {
    cx.export_function("newWorker", worker_new)?;
    cx.export_function("workerShutdown", worker_shutdown)?;
    cx.export_function("workerPoll", worker_poll)?;
    cx.export_function("workerCompleteTask", worker_complete_task)?;
    Ok(())
});
