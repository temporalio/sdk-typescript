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
    clippy::multiple_crate_versions
)]

pub mod helpers;

mod client;
mod ephemeral_server;
mod logs;
mod runtime;
mod worker;

#[neon::main]
fn main(mut cx: neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    runtime::init(&mut cx)?;
    client::init(&mut cx)?;
    worker::init(&mut cx)?;
    logs::init(&mut cx)?;
    ephemeral_server::init(&mut cx)?;

    Ok(())
}
