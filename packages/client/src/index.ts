/**
 * Client for communicating with the Temporal service.
 *
 * Interact with workflows using {@link WorkflowClient} or call GRPC methods directly using {@link Connection.service}.
 *
 * ### Usage
 * <!--SNIPSTART nodejs-hello-client-->
 * <!--SNIPEND-->
 * @module
 */

export * from './workflow-client';
export * from './connection';
export * from './types';
export * from './workflow-options';
export * from './interceptors';

export { DataConverter, defaultDataConverter } from '@temporalio/workflow';
