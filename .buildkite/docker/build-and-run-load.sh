#!/usr/bin/env sh
set -e
set -x

node --version
npm --version

npm set progress=false
export SKIP_DOCS_INSTALL=true

npm ci
npm run build

npm run ci-load