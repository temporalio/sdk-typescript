'use strict';

module.exports = {
  timeout: '60s',
  concurrency: 1,
  workerThreads: false,
  require: process.env.TEMPORAL_AVA_OBSERVER_RUN_ID ? ['./lib/ava-ci-observer.js'] : [],
};
