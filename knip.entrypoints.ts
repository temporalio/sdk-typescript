// Analysis-only consumers for public APIs and modules loaded by path at runtime.
// Legacy lib/* exports make every SDK source file a package entrypoint, so Knip
// checks entry exports and uses these consumers to identify the supported API.
// This file is parsed by Knip and is never executed.

import { decodeActivityCancellationType } from './packages/common/src/activity-options';
import { encodeSuggestContinueAsNewReason } from './packages/common/src/continue-as-new';
import { _ as unusedSearchAttributeDecoder } from './packages/common/src/search-attributes';
import { decodeChildWorkflowCancellationType, decodeParentClosePolicy } from './packages/workflow/src/interfaces';
import type { MakeTelemetryFilterStringOptions } from './packages/worker/src/runtime-options';

// Keep the unused halves of paired enum converters and the deprecated public type.
void [
  decodeActivityCancellationType,
  encodeSuggestContinueAsNewReason,
  unusedSearchAttributeDecoder,
  decodeChildWorkflowCancellationType,
  decodeParentClosePolicy,
];
const legacyOptions: MakeTelemetryFilterStringOptions | undefined = undefined;
void legacyOptions;

void import('./packages/activity/src/index');
void import('./packages/client/src/index');
void import('./packages/client/src/internal');
void import('./packages/cloud/src/index');
void import('./packages/common/src/index');
void import('./packages/common/src/internal-non-workflow/index');
void import('./packages/common/src/internal-workflow/index');
void import('./packages/common/src/protobufs');
void import('./packages/common/src/type-helpers');
void import('./packages/create-project/src/index');
void import('./packages/envconfig/src/index');
void import('./packages/meta/src/index');
void import('./packages/nyc-test-coverage/src/index');
void import('./packages/plugin/src/index');
void import('./packages/testing/src/index');
void import('./packages/worker/src/index');
void import('./packages/worker/src/workflow/workflow-worker-thread');
void import('./packages/workflow/src/index');
void import('./packages/workflow/src/worker-interface');
void import('./contrib/external-storage-gcs/src/index');
void import('./contrib/external-storage-gcs-google-sdk/src/index');
void import('./contrib/external-storage-s3/src/index');
void import('./contrib/external-storage-s3-aws-sdk/src/index');
void import('./contrib/interceptors-opentelemetry/src/index');
void import('./contrib/interceptors-opentelemetry/src/workflow-interceptors');
void import('./contrib/interceptors-opentelemetry-v2/src/index');
void import('./contrib/interceptors-opentelemetry-v2/src/workflow-interceptors');
void import('./contrib/workflow-streams/src/client');
void import('./contrib/workflow-streams/src/workflow');
void import('./packages/lambda-worker/src/index');
void import('./packages/lambda-worker/src/otel');
void import('./packages/test-helpers/src/index');
void import('./packages/core-bridge/ts/index');
void import('./packages/core-bridge/index.js');
void import('./packages/common/src/proto-utils');
void import('./packages/workflow/src/internal');
void import('./packages/workflow/src/global-overrides');
void import('./packages/worker/src/workflow-log-interceptor');
void import('./packages/worker/src/debug-replayer/inbound-interceptor');
