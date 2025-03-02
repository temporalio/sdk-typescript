// /// When Future completes, call given JS callback using a neon::Channel with either error or
// /// undefined
// pub async fn void_future_to_js_promise<E, F, ER, EF>(
//     channel: Arc<Channel>,
//     f: F,
//     error_function: EF,
// ) where
//     E: Display + Send + 'static,
//     F: Future<Output = Result<(), E>> + Send,
//     ER: Object,
//     EF: for<'a> FnOnce(&mut TaskContext<'a>, E) -> JsResult<'a, ER> + Send + 'static,
// {
//     let (deferred, promise) = cx.promise();

//     f.await;

//     match  {
//         Ok(()) => {
//             send_result(channel, callback, |cx| Ok(cx.undefined()));
//         }
//         Err(err) => {
//             send_error(channel, callback, |cx| error_function(cx, err));
//         }
//     }
// }
