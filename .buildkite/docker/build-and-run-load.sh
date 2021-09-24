#!/usr/bin/env sh
set -e
set -x

node --version
npm --version

npm set progress=false
export TEMPORAL_TESTING_SERVER_URL="temporal:7233"

npm ci
npm run build
npm run ci-load
