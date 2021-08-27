#!/usr/bin/env sh
set -e
set -x

node --version
npm --version

npm set progress=false
export SKIP_DOCS_INSTALL=true
export TEMPORAL_TESTING_SERVER_URL="temporal:7233"

npm ci
# Try rebuilding once if it fails
# TODO: Figure out whatever problem causes "common" package to not get compiled when it should
npm run build || npm run build

npm run ci-load