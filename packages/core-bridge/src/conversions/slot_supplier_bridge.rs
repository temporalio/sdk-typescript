use crate::helpers::{get_optional, js_getter};
use log::{error, warn};
use neon::types::JsNull;
use neon::{
    context::Context,
    context::FunctionContext,
    event::Channel,
    handle::{Handle, Root},
    object::Object,
    prelude::{JsBuffer, JsFunction, JsObject, JsPromise, JsUndefined, JsValue, NeonResult, Value},
};
use prost::Message;
use std::{cell::RefCell, marker::PhantomData, sync::Arc, time::Duration};
use temporal_sdk_core::api::worker::{
    SlotKind, SlotKindType, SlotMarkUsedContext, SlotReleaseContext, SlotReservationContext,
    SlotSupplier, SlotSupplierPermit,
};
use tokio::sync::oneshot;

pub struct SlotSupplierBridge<SK> {
    inner: Arc<Root<JsObject>>,
    reserve_cb: Arc<Root<JsFunction>>,
    try_reserve_cb: Arc<Root<JsFunction>>,
    mark_used_cb: Arc<Root<JsFunction>>,
    release_cb: Arc<Root<JsFunction>>,
    channel: Channel,
    _kind: PhantomData<SK>,
}

impl<SK> SlotSupplierBridge<SK> {
    pub(crate) fn new(cx: &mut FunctionContext, obj: Handle<'_, JsObject>) -> NeonResult<Self> {
        Ok(Self {
            inner: Arc::new(obj.root(cx)),
            // Callbacks for each function are cached to reduce calling overhead
            reserve_cb: Arc::new(js_getter!(cx, &obj, "reserveSlot", JsFunction).root(cx)),
            try_reserve_cb: Arc::new(js_getter!(cx, &obj, "tryReserveSlot", JsFunction).root(cx)),
            mark_used_cb: Arc::new(js_getter!(cx, &obj, "markSlotUsed", JsFunction).root(cx)),
            release_cb: Arc::new(js_getter!(cx, &obj, "releaseSlot", JsFunction).root(cx)),
            channel: cx.channel(),
            _kind: PhantomData,
        })
    }
}

struct BridgePermitData {
    permit: Arc<Root<JsObject>>,
}

struct CallAbortOnDrop {
    chan: Channel,
    aborter: oneshot::Receiver<Root<JsFunction>>,
}

impl Drop for CallAbortOnDrop {
    fn drop(&mut self) {
        if let Ok(aborter) = self.aborter.try_recv() {
            let _ = self.chan.try_send(move |mut cx| {
                let cb = aborter.to_inner(&mut cx);
                let this = cx.undefined();
                let _ = cb.call(&mut cx, this, []);
                Ok(())
            });
        }
    }
}

static PERMIT_DATA_FIELD: &str = "permit_data";

#[async_trait::async_trait]
impl<SK: SlotKind + Send + Sync> SlotSupplier for SlotSupplierBridge<SK> {
    type SlotKind = SK;

    async fn reserve_slot(&self, ctx: &dyn SlotReservationContext) -> SlotSupplierPermit {
        loop {
            let inner = self.inner.clone();
            let rcb = self.reserve_cb.clone();
            let task_queue = ctx.task_queue().to_string();
            let worker_identity = ctx.worker_identity().to_string();
            let worker_build_id = ctx.worker_build_id().to_string();
            let is_sticky = ctx.is_sticky();

            let (callback_fut, _abort_on_drop) = match self
                .channel
                .send(move |mut cx| {
                    let context = Self::mk_reserve_ctx(
                        task_queue,
                        worker_identity,
                        worker_build_id,
                        is_sticky,
                        &mut cx,
                    )?;
                    let (aborter_tx, aborter) = oneshot::channel();
                    let abort_on_drop = CallAbortOnDrop {
                        chan: cx.channel(),
                        aborter,
                    };
                    let aborter_tx = RefCell::new(Some(aborter_tx));
                    let abort_func = JsFunction::new(&mut cx, move |mut cx| {
                        let func: Handle<JsFunction> = cx.argument(0)?;
                        if let Some(aborter_tx) = aborter_tx.take() {
                            let _ = aborter_tx.send(func.root(&mut cx));
                        }
                        Ok(cx.undefined())
                    })?
                    .upcast();

                    let this = (*inner).clone(&mut cx).into_inner(&mut cx);
                    let val = rcb
                        .to_inner(&mut cx)
                        .call(&mut cx, this, [context, abort_func])?;
                    let as_prom = val.downcast_or_throw::<JsPromise, _>(&mut cx)?;
                    let fut = as_prom.to_future(&mut cx, |mut cx, result| match result {
                        Ok(value) => {
                            let permit_obj = JsObject::new(&mut cx);
                            permit_obj.set(&mut cx, PERMIT_DATA_FIELD, value)?;
                            Ok(Ok(permit_obj.root(&mut cx)))
                        }
                        Err(_) => Ok(Err(())),
                    })?;
                    Ok((fut, abort_on_drop))
                })
                .await
            {
                Ok(v) => v,
                Err(e) => {
                    warn!("Error reserving slot: {:?}", e);
                    continue;
                }
            };

            match callback_fut.await {
                Ok(Ok(res)) => {
                    let permit = SlotSupplierPermit::with_user_data(BridgePermitData {
                        permit: Arc::new(res),
                    });
                    return permit;
                }
                // Error in user function
                Ok(Err(())) => {
                    // Nothing to do here. Error in user's function (or an abort).
                    // Logging handled on the JS side.
                }
                Err(e) => {
                    error!(
                        "There was an error in the rust/node bridge while reserving a slot: {}",
                        e
                    );
                }
            }
            // Wait a beat to avoid spamming errors
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
    }

    fn try_reserve_slot(&self, ctx: &dyn SlotReservationContext) -> Option<SlotSupplierPermit> {
        let inner = self.inner.clone();
        let rcb = self.try_reserve_cb.clone();
        let task_queue = ctx.task_queue().to_string();
        let worker_identity = ctx.worker_identity().to_string();
        let worker_build_id = ctx.worker_build_id().to_string();
        let is_sticky = ctx.is_sticky();

        // This is... unfortunate but since this method is called from an async context way up
        // the stack, but is not async itself AND we need some way to get the result from the JS
        // callback, we must use this roundabout way of blocking. Simply calling `join` on the
        // channel send won't work - it'll panic because it calls block_on internally.
        let runtime_handle = tokio::runtime::Handle::current();
        let _entered = runtime_handle.enter();
        let callback_res = futures::executor::block_on(self.channel.send(move |mut cx| {
            let context = Self::mk_reserve_ctx(
                task_queue,
                worker_identity,
                worker_build_id,
                is_sticky,
                &mut cx,
            )?;

            let this = (*inner).clone(&mut cx).into_inner(&mut cx);
            let val = rcb.to_inner(&mut cx).call(&mut cx, this, [context])?;
            if val.is_a::<JsUndefined, _>(&mut cx) || val.is_a::<JsNull, _>(&mut cx) {
                return Ok(None);
            }
            let permit_obj = JsObject::new(&mut cx);
            permit_obj.set(&mut cx, PERMIT_DATA_FIELD, val)?;
            Ok(Some(permit_obj.root(&mut cx)))
        }));

        // Ignore errors, they'll be logged by JS
        callback_res.ok().flatten().map(|res| {
            SlotSupplierPermit::with_user_data(BridgePermitData {
                permit: Arc::new(res),
            })
        })
    }

    fn mark_slot_used(&self, ctx: &dyn SlotMarkUsedContext<SlotKind = Self::SlotKind>) {
        let inner = self.inner.clone();
        let cb = self.mark_used_cb.clone();
        let permit_data = ctx
            .permit()
            .user_data::<BridgePermitData>()
            .map(|d| d.permit.clone());
        // Get the slot info as bytes
        let slot_info_bytes = ctx.info().encode_to_vec();

        self.channel.send(move |mut cx| {
            let context = JsObject::new(&mut cx);
            if let Some(permit_obj) = permit_data {
                let ph: Handle<JsObject> = permit_obj.to_inner(&mut cx);
                let pd = ph.get_value(&mut cx, PERMIT_DATA_FIELD)?;
                context.set(&mut cx, "permit", pd)?;
            }
            let slot_info = JsBuffer::from_slice(&mut cx, &slot_info_bytes)?;
            context.set(&mut cx, "slotInfo", slot_info)?;
            let context = context.as_value(&mut cx);

            let this = (*inner).clone(&mut cx).into_inner(&mut cx);
            let val = cb.to_inner(&mut cx).call(&mut cx, this, [context])?;
            if val.is_a::<JsUndefined, _>(&mut cx) {
                return Ok(None);
            }
            let as_obj = val.downcast_or_throw::<JsObject, _>(&mut cx)?;
            Ok(Some(as_obj.root(&mut cx)))
        });
    }

    fn release_slot(&self, ctx: &dyn SlotReleaseContext<SlotKind = Self::SlotKind>) {
        let inner = self.inner.clone();
        let cb = self.release_cb.clone();
        let permit_data = ctx
            .permit()
            .user_data::<BridgePermitData>()
            .map(|d| d.permit.clone());
        // Get the slot info as bytes
        let slot_info_bytes = ctx.info().map(|m| m.encode_to_vec());

        self.channel.send(move |mut cx| {
            let context = JsObject::new(&mut cx);
            if let Some(permit_obj) = permit_data {
                let ph: Handle<JsObject> = permit_obj.to_inner(&mut cx);
                let pd = ph.get_value(&mut cx, PERMIT_DATA_FIELD)?;
                context.set(&mut cx, "permit", pd)?;
            }
            if let Some(slot_info_bytes) = slot_info_bytes {
                let slot_info = JsBuffer::from_slice(&mut cx, &slot_info_bytes)?;
                context.set(&mut cx, "slotInfo", slot_info)?;
            }
            let context = context.as_value(&mut cx);

            let this = (*inner).clone(&mut cx).into_inner(&mut cx);
            let val = cb.to_inner(&mut cx).call(&mut cx, this, [context])?;
            if val.is_a::<JsUndefined, _>(&mut cx) {
                return Ok(None);
            }
            let as_obj = val.downcast_or_throw::<JsObject, _>(&mut cx)?;
            Ok(Some(as_obj.root(&mut cx)))
        });
    }
}

impl<SK: SlotKind> SlotSupplierBridge<SK> {
    fn mk_reserve_ctx<'a, C: Context<'a>>(
        task_queue: String,
        worker_identity: String,
        worker_build_id: String,
        is_sticky: bool,
        cx: &mut C,
    ) -> NeonResult<Handle<'a, JsValue>> {
        let context = JsObject::new(cx);
        let slottype = cx.string(match SK::kind() {
            SlotKindType::Workflow => "workflow",
            SlotKindType::Activity => "activity",
            SlotKindType::LocalActivity => "local-activity",
            SlotKindType::Nexus => {
                // This won't get hit as we'll not even try to run a Nexus poller
                panic!("Nexus is not yet implemented");
            }
        });
        context.set(cx, "slotType", slottype)?;
        let tq = cx.string(task_queue);
        context.set(cx, "taskQueue", tq)?;
        let wid = cx.string(worker_identity);
        context.set(cx, "workerIdentity", wid)?;
        let bid = cx.string(worker_build_id);
        context.set(cx, "workerBuildId", bid)?;
        let is_sticky = cx.boolean(is_sticky);
        context.set(cx, "isSticky", is_sticky)?;
        let context = context.as_value(cx);
        Ok(context)
    }
}
