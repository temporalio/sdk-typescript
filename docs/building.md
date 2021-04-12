## Building `temporal_sdk_node_bridge`

`temporal_sdk_node_bridge` is a native NodeJS module written in Rust using [neon](https://neon-bindings.com/).
One of the advantages of using Rust is that it's easy to cross compile to various platforms and architectures.

By using NodeJS' `n-api` we get a binary which _should_ work on all supported Node versions thanks to `n-api`'s [ABI stability](https://nodejs.org/en/docs/guides/abi-stability/).

### Prerequisites for M1 Macs

1. Install rosetta with `softwareupdate --install-rosetta`
1. Make sure you have brew under Rosetta alongside your M1 brew intallation<br/>
   See: https://github.com/Homebrew/brew/issues/9173<br/>
   `arch -x86_64 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install.sh)"`

### Setting up a Rust cross-compilation MacOS build environment

1. Download [rustup](https://rustup.rs/).
1. Run `rustup target add x86_64-apple-darwin` - if you're using a mac with an M1 chip
1. Run `rustup target add aarch64-apple-darwin` - if you're using a mac with an Intel chip<br/>
   **NOTE:** you can only compile for aarch64 if you have MacOS Big Sur or later
1. Run `rustup target add x86_64-pc-windows-gnu`
1. Run `rustup target add x86_64-unknown-linux-gnu`
1. Run `brew tap SergioBenitez/osxct`
1. Run `brew install x86_64-unknown-linux-gnu` to enable Linux compilation
1. Run `brew install mingw-w64` to enable Windows compilation on Intel Macs<br/>
   Or `arch -x86_64 /usr/local/bin/brew install mingw-w64` on M1 Macs
1. Configure cargo for the Windows and Linux build targets
   `cp etc/mac-cargo-config.toml ~/.cargo/config.toml`
1. Install the project's dependencies with `NPM_CONFIG_FOREGROUND_SCRIPTS=true npm ci` if you haven't already
1. Build the the bridge with `TEMPORAL_WORKER_BUILD_TARGETS=all npx lerna run --stream build-rust`
