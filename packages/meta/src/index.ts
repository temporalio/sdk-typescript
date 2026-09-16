// ORDER IS IMPORTANT! When a type is re-exported, TypeDoc will keep the first
// one it encountered as canonical, and mark others as references to that one.
export * as protobufs from '@temporalio/common/lib/protobufs';
export * as proto from '@temporalio/proto';
export * as common from '@temporalio/common';
export * as workflow from '@temporalio/workflow';
export * as activity from '@temporalio/activity';
export * as worker from '@temporalio/worker';
export * as client from '@temporalio/client';
export * as nexus from '@temporalio/nexus';
export * as testing from '@temporalio/testing';
export * as opentelemetry from '@temporalio/interceptors-opentelemetry';
export * as envconfig from '@temporalio/envconfig';
export * as plugin from '@temporalio/plugin';
export * as cloud from '@temporalio/cloud';
export * as aisdk from '@temporalio/ai-sdk';

// Force TypeDoc to convert these unexported helpers so that the elide-to
// plugin (packages/docs/typedoc-plugins/elide-to.mjs) can read their
// `@elideTo` annotations. References to them get collapsed to the named
// type parameter in the rendered docs.
export type { RequireAtLeastOne, Replace } from '@temporalio/common/lib/type-helpers';
