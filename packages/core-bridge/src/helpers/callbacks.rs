use std::{marker::PhantomData, sync::Arc};

use neon::{
    event::Channel,
    handle::{Handle, Root},
    object::Object,
    prelude::Context,
    types::{JsFunction, JsFuture, JsObject, JsPromise, JsValue, Value as _},
};
use tracing::error;

use super::{BridgeError, BridgeResult, TryFromJs, TryIntoJs, errors::IntoThrow as _};

/// A callback is a JS function that is meant to be called by the Rust side.
/// A `JsCallback` is a callback that returns a value synchronously.
#[derive(Debug)]
pub struct JsCallback<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync,
    Ret: TryFromJs + Send + Sync,
{
    inner: Arc<CallbackInner<Args, Ret>>,
}

impl<Args, Ret> Clone for JsCallback<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync,
    Ret: TryFromJs + Send + Sync,
{
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<Args, Ret> JsCallback<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync + 'static,
    Ret: TryFromJs + Send + Sync + 'static,
{
    pub fn new<'cx, C: Context<'cx>>(
        cx: &mut C,
        func: Handle<JsFunction>,
        this: Option<Handle<JsObject>>,
    ) -> Self {
        Self {
            inner: Arc::new(CallbackInner {
                this: this.map(|t| t.root(cx)),
                func: func.root(cx),
                func_name: func
                    .to_string(cx)
                    .map_or_else(|_| "anonymous func".to_owned(), |s| s.value(cx)),
                chan: cx.channel(),
                _marker: PhantomData,
            }),
        }
    }

    /// Synchronously call the callback from the current JS thread.
    pub fn call<'cx, C: Context<'cx>>(&self, cx: &mut C, args: Args) -> BridgeResult<Ret> {
        let inner = self.inner.clone();
        inner.call(cx, args)
    }

    /// Call the callback on the JS thread and return a handle to the result.
    pub fn call_on_js_thread(&self, args: Args) -> BridgeResult<neon::event::JoinHandle<Ret>> {
        let inner = self.inner.clone();

        let ret = inner
            .chan
            .clone()
            .try_send(move |mut cx| inner.call(&mut cx, args).into_throw(&mut cx))
            .map_err(|e| BridgeError::Other(e.into()))?;

        Ok(ret)
    }

    pub fn call_and_block(&self, args: Args) -> BridgeResult<Ret> {
        let join_handle = self.call_on_js_thread(args)?;

        // This is... unfortunate but since this method is called from an async context way up
        // the stack, but is not async itself AND we need some way to get the result from the JS
        // callback, we must use this roundabout way of blocking. Simply calling `join` on the
        // channel send won't work - it'll panic because it calls block_on internally.
        let callback_res = futures::executor::block_on(join_handle);

        match callback_res {
            Ok(x) => Ok(x),
            Err(e) => Err(BridgeError::Other(e.into())),
        }
    }
}

/// Unfortunately, the `TryFromJS` trait doesn't have access to the containing object, and therefore
/// can't preserve the `this` context. If the JS side API presents the callback as a method on some
/// object, then the function should be `bind(this)`'d on the JS side before passing it to Rust.
impl<Args, Ret> TryFromJs for JsCallback<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync + 'static,
    Ret: TryFromJs + Send + Sync + 'static,
{
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let func = js_value.downcast::<JsFunction, _>(cx)?;
        Ok(Self::new(cx, func, None))
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub struct JsAsyncCallback<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync,
    Ret: TryFromJs + Send + Sync + 'static,
{
    inner: Arc<CallbackInner<Args, JsFuture<BridgeResult<Ret>>>>,
}

impl<Args, Ret> JsAsyncCallback<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync + 'static,
    Ret: TryFromJs + Send + Sync + 'static,
{
    pub fn new<'cx, C: Context<'cx>>(
        cx: &mut C,
        func: Handle<JsFunction>,
        this: Option<Handle<JsObject>>,
    ) -> Self {
        Self {
            inner: Arc::new(CallbackInner {
                this: this.map(|t| t.root(cx)),
                func: func.root(cx),
                func_name: func
                    .to_string(cx)
                    .map_or_else(|_| "anonymous func".to_owned(), |s| s.value(cx)),
                chan: cx.channel(),
                _marker: PhantomData,
            }),
        }
    }

    pub async fn call(&self, args: Args) -> BridgeResult<Ret> {
        let inner = self.inner.clone();

        let join_handle = inner
            .chan
            .clone()
            .try_send(move |mut cx| inner.call(&mut cx, args).into_throw(&mut cx))
            .map_err(|e| BridgeError::Other(e.into()))?;

        // Wait for the JS function to return a Promise...
        let res = join_handle.await;
        let future = res.map_err(|e| BridgeError::Other(e.into()))?;

        // ... and then wait for the Promise to resolve
        let res = future.await;
        let res = res.map_err(|e| BridgeError::Other(e.into()))??;
        Ok(res)
    }
}

/// Unfortunately, the `TryFromJS` trait doesn't have access to the containing object, and therefore
/// can't preserve the `this` context. If the JS side API presents the callback as a method on some
/// object, then the function should be `bind(this)`'d on the JS side before passing it to Rust.
impl<Args, Ret> TryFromJs for JsAsyncCallback<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync + 'static,
    Ret: TryFromJs + Send + Sync + 'static,
{
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let func = js_value.downcast::<JsFunction, _>(cx)?;
        Ok(Self::new(cx, func, None))
    }
}

impl<R: TryFromJs + Send + Sync + 'static> TryFromJs for JsFuture<BridgeResult<R>> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let promise = js_value.downcast::<JsPromise, _>(cx)?;
        let future = promise.to_future(cx, |mut cx, result| match result {
            Ok(value) => {
                // Promise resolved, but there might still be an error trying to
                // convert the promise's returned value to the desired type.
                let val = R::try_from_js(&mut cx, value);
                match val {
                    Ok(val) => Ok(Ok(val)),
                    Err(e) => Ok(Err(e)),
                }
            }
            Err(e) => {
                // Promise failed to resolve
                let err_str = e.to_string(&mut cx)?.value(&mut cx);
                Ok(Err(BridgeError::UnexpectedError(err_str)))
            }
        })?;

        Ok(future)
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

#[derive(Debug)]
struct CallbackInner<Args, Ret>
where
    Args: TryIntoJsArgs + Send + Sync,
    Ret: TryFromJs + Send + Sync,
{
    this: Option<Root<JsObject>>,
    func: Root<JsFunction>,
    func_name: String,
    chan: Channel,
    _marker: PhantomData<(Args, Ret)>,
}

impl<Args: TryIntoJsArgs + Send + Sync, Ret: TryFromJs + Send + Sync> CallbackInner<Args, Ret> {
    fn call<'a, C: Context<'a>>(&self, cx: &mut C, args: Args) -> BridgeResult<Ret> {
        let this: Handle<'a, JsValue> = self
            .this
            .as_ref()
            .map_or(cx.undefined().upcast(), |t| t.to_inner(cx).upcast());

        // Convert the arguments to a JS array using the new trait
        let js_args = args.try_into_js_args(cx)?;

        // Call the function with the JS arguments directly
        let ret = cx
            .try_catch(|cx| self.func.to_inner(cx).call(cx, this, js_args))
            .map_err(|e| {
                let err_str = format!(
                    "Error calling JS callback '{}' on JS thread, {:?}",
                    self.func_name, e
                );
                error!(err_str);
                BridgeError::UnexpectedError(err_str)
            })?;

        <Ret>::try_from_js(cx, ret)
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// A trait to build an arguments array for a JS function call from a tuple.
pub trait TryIntoJsArgs {
    fn try_into_js_args<'cx, 'a>(
        self,
        cx: &mut impl Context<'cx>,
    ) -> BridgeResult<Vec<Handle<'a, JsValue>>>
    where
        'cx: 'a;
}

impl TryIntoJsArgs for () {
    fn try_into_js_args<'cx, 'a>(
        self,
        _cx: &mut impl Context<'cx>,
    ) -> BridgeResult<Vec<Handle<'a, JsValue>>>
    where
        'cx: 'a,
    {
        Ok(Vec::new())
    }
}

impl<T0: TryIntoJs> TryIntoJsArgs for (T0,) {
    fn try_into_js_args<'cx, 'a>(
        self,
        cx: &mut impl Context<'cx>,
    ) -> BridgeResult<Vec<Handle<'a, JsValue>>>
    where
        'cx: 'a,
    {
        let js_value = self.0.try_into_js(cx)?;
        Ok(vec![js_value.upcast()])
    }
}

impl<T0: TryIntoJs, T1: TryIntoJs> TryIntoJsArgs for (T0, T1) {
    fn try_into_js_args<'cx, 'a>(
        self,
        cx: &mut impl Context<'cx>,
    ) -> BridgeResult<Vec<Handle<'a, JsValue>>>
    where
        'cx: 'a,
    {
        let v0 = self.0.try_into_js(cx)?;
        let v1 = self.1.try_into_js(cx)?;
        Ok(vec![v0.upcast(), v1.upcast()])
    }
}
