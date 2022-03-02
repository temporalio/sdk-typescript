import { Payload, PayloadCodec, ProtoFailure } from '@temporalio/common';
import { decodeFailure, encodeFailure } from '@temporalio/internal-non-workflow-common';
import { coresdk } from '@temporalio/proto';
import { clone, setWith } from 'lodash';

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  constructor(protected readonly codec: PayloadCodec) {}

  /**
   * Run codec.decode on the Payloads in the Activation message.
   */
  public async decodeActivation(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_activation.IWorkflowActivation> {
    const decodedActivation = { ...activation };
    if (activation.jobs?.length) {
      decodedActivation.jobs = await Promise.all(
        activation.jobs.map(async (job) => {
          const decodedJob = { ...job };
          if (decodedJob.startWorkflow?.arguments) {
            setWith(
              decodedJob,
              'startWorkflow.arguments',
              await this.codec.decode(decodedJob.startWorkflow.arguments),
              clone
            );
          }
          if (decodedJob.queryWorkflow?.arguments) {
            setWith(
              decodedJob,
              'queryWorkflow.arguments',
              await this.codec.decode(decodedJob.queryWorkflow.arguments),
              clone
            );
          }
          if (decodedJob.cancelWorkflow?.details) {
            setWith(
              decodedJob,
              'cancelWorkflow.details',
              await this.codec.decode(decodedJob.cancelWorkflow.details),
              clone
            );
          }
          if (decodedJob.signalWorkflow?.input) {
            setWith(
              decodedJob,
              'signalWorkflow.input',
              await this.codec.decode(decodedJob.signalWorkflow.input),
              clone
            );
          }
          // if (decodedJob.startWorkflow?.headers) {
          //   await Promise.all(
          //     Object.entries(decodedJob.startWorkflow.headers).map(async ([header, payload]) => {
          //       const [decodedPayload] = await this.codec.decode([payload]);
          //       setWith(decodedJob, `startWorkflow.headers.${header}`, decodedPayload, clone);
          //     })
          //   );
          // }
          if (decodedJob.resolveActivity?.result?.completed?.result) {
            const [decodedResult] = await this.codec.decode([decodedJob.resolveActivity.result.completed.result]);
            setWith(decodedJob, 'resolveActivity.result.completed.result', decodedResult, clone);
          }
          if (decodedJob.resolveChildWorkflowExecution?.result?.completed?.result) {
            const [decodedResult] = await this.codec.decode([
              decodedJob.resolveChildWorkflowExecution.result.completed.result,
            ]);
            setWith(decodedJob, 'resolveChildWorkflowExecution.result.completed.result', decodedResult, clone);
          }
          if (decodedJob.resolveActivity?.result?.failed?.failure) {
            decodedJob.resolveActivity.result.failed.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveActivity.result.failed.failure
            );
          }
          if (decodedJob.resolveActivity?.result?.cancelled?.failure) {
            decodedJob.resolveActivity.result.cancelled.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveActivity.result.cancelled.failure
            );
          }
          if (decodedJob.resolveChildWorkflowExecutionStart?.cancelled?.failure) {
            decodedJob.resolveChildWorkflowExecutionStart.cancelled.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveChildWorkflowExecutionStart.cancelled.failure
            );
          }
          if (decodedJob.resolveSignalExternalWorkflow?.failure) {
            decodedJob.resolveSignalExternalWorkflow.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveSignalExternalWorkflow.failure
            );
          }
          if (decodedJob.resolveChildWorkflowExecution?.result?.failed?.failure) {
            decodedJob.resolveChildWorkflowExecution.result.failed.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveChildWorkflowExecution.result.failed.failure
            );
          }
          if (decodedJob.resolveChildWorkflowExecution?.result?.cancelled?.failure) {
            decodedJob.resolveChildWorkflowExecution.result.cancelled.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveChildWorkflowExecution.result.cancelled.failure
            );
          }
          if (decodedJob.resolveRequestCancelExternalWorkflow?.failure) {
            decodedJob.resolveRequestCancelExternalWorkflow.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveRequestCancelExternalWorkflow.failure
            );
          }
          return decodedJob;
        })
      );
    }
    return decodedActivation;
  }

  /**
   * Run codec.encode on the Payloads inside the Completion message.
   */
  public async encodeCompletion(completionBytes: Uint8Array): Promise<Uint8Array> {
    const completion = coresdk.workflow_completion.WorkflowActivationCompletion.decodeDelimited(completionBytes);

    await Promise.all([
      ...(completion.successful?.commands?.flatMap((command) =>
        command
          ? [
              // ...this.encodeMap(command.scheduleActivity, 'headerFields'),
              this.encodeArray(command.scheduleActivity, 'arguments'),
              this.encodeField(command.respondToQuery?.succeeded, 'response'),
              this.encodeFailure(command.respondToQuery, 'failed'),
              this.encodeField(command.completeWorkflowExecution, 'result'),
              this.encodeFailure(command.failWorkflowExecution, 'failure'),
              this.encodeArray(command.continueAsNewWorkflowExecution, 'arguments'),
              ...this.encodeMap(command.continueAsNewWorkflowExecution, 'memo'),
              // ...this.encodeMap(command.continueAsNewWorkflowExecution, 'header'),
              ...this.encodeMap(command.continueAsNewWorkflowExecution, 'searchAttributes'),
              this.encodeArray(command.startChildWorkflowExecution, 'input'),
              ...this.encodeMap(command.startChildWorkflowExecution, 'memo'),
              // ...this.encodeMap(command.startChildWorkflowExecution, 'header'),
              ...this.encodeMap(command.startChildWorkflowExecution, 'searchAttributes'),
              this.encodeArray(command.signalExternalWorkflowExecution, 'args'),
            ]
          : []
      ) ?? []),
      this.encodeFailure(completion, 'failed'),
    ]);

    return coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(completion).finish();
  }

  protected async encodeField(object: unknown, field: string): Promise<void> {
    if (!object) return;
    const record = object as Record<string, unknown>;
    if (!(field in record)) return;

    const [encodedPayload] = await this.codec.encode([record[field] as Payload]);
    record[field] = encodedPayload;
  }

  protected async encodeArray(object: unknown, field: string): Promise<void> {
    if (!object) return;
    const record = object as Record<string, unknown>;
    if (!record[field]) return;

    record[field] = await this.codec.encode(record[field] as Payload[]);
  }

  protected encodeMap(object: unknown, field: string): Promise<void>[] {
    if (!object) return [];
    const record = object as Record<string, unknown>;
    if (!record[field]) return [];

    return Object.entries(record[field] as Record<string, Payload>).map(async ([k, v]) => {
      const [encodedPayload] = await this.codec.encode([v]);
      (record[field] as Record<string, unknown>)[k] = encodedPayload;
    });
  }

  protected async encodeFailure(object: unknown, field: string): Promise<void> {
    if (!object) return;
    const record = object as Record<string, unknown>;
    if (!record[field]) return;

    record[field] = await encodeFailure(this.codec, record[field] as ProtoFailure);
  }
}
