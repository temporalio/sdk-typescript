use neon::{context::Context, handle::Handle, prelude::*};

/// Print out a JS object to the console.
///
/// Literally: `console.log(obj)`.
pub fn log_js_object<'a, 'b, C: Context<'b>>(
    cx: &mut C,
    js_object: &Handle<'a, JsValue>,
) -> NeonResult<()> {
    let global = cx.global_object();
    let console = global.get::<JsObject, _, _>(cx, "console")?;
    let log = console.get::<JsFunction, _, _>(cx, "log")?;
    let args = vec![js_object.upcast()]; // Upcast js_object to JsValue

    log.call(cx, console, args)?;

    Ok(())
}
