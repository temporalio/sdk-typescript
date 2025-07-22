#![warn(
    clippy::pedantic,
    clippy::nursery,
    clippy::cargo,
    clippy::perf,
    clippy::style
)]
#![allow(
    clippy::missing_errors_doc,
    clippy::too_long_first_doc_paragraph,
    clippy::option_if_let_else,
    clippy::multiple_crate_versions,
    clippy::significant_drop_tightening
)]

pub mod helpers;

mod client;
mod logs;
mod metrics;
mod runtime;
mod testing;
mod worker;

#[neon::main]
fn main(mut cx: neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    client::init(&mut cx)?;
    logs::init(&mut cx)?;
    metrics::init(&mut cx)?;
    runtime::init(&mut cx)?;
    testing::init(&mut cx)?;
    worker::init(&mut cx)?;

    Ok(())
}
