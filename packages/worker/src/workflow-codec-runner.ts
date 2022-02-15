import { decodeFailure, encodeFailure, Payload } from '@temporalio/common';
import { coresdk, temporal } from '@temporalio/proto';
import { PayloadCodec, ProtoFailure } from '@temporalio/workflow-common';

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  constructor(protected readonly codec: PayloadCodec) {}

  /**
   * Run codec.decode on the Payloads in the Activation message.
   */
  public async decodeActivation(activation: coresdk.workflow_activation.IWorkflowActivation): Promise<void> {
    if (activation.jobs?.length) {
      await Promise.all(
        activation.jobs.flatMap((job) => [
          this.decodeArray(job.startWorkflow, 'arguments'),
          ...this.decodeMap(job.startWorkflow, 'headers'),
          this.decodeArray(job.queryWorkflow, 'arguments'),
          this.decodeArray(job.cancelWorkflow, 'details'),
          this.decodeArray(job.signalWorkflow, 'input'),
          this.decodeField(job.resolveActivity?.result?.completed, 'result'),
          this.decodeField(job.resolveChildWorkflowExecution?.result?.completed, 'result'),
          this.decodeFailure(job.resolveActivity?.result?.failed),
          this.decodeFailure(job.resolveActivity?.result?.cancelled),
          this.decodeFailure(job.resolveChildWorkflowExecutionStart?.cancelled),
          this.decodeFailure(job.resolveSignalExternalWorkflow),
          this.decodeFailure(job.resolveChildWorkflowExecution?.result?.failed),
          this.decodeFailure(job.resolveChildWorkflowExecution?.result?.cancelled),
          this.decodeFailure(job.resolveRequestCancelExternalWorkflow),
        ])
      );
    }
  }

  protected async decodeField(object: unknown, field: string): Promise<void> {
    if (!object) return;
    const record = object as Record<string, unknown>;
    if (!record[field]) return;

    const [decodedPayload] = await this.codec.decode([record[field] as Payload]);
    record[field] = decodedPayload;
  }

  protected async decodeArray(object: unknown, field: string): Promise<void> {
    if (!object) return;
    const record = object as Record<string, unknown>;
    if (!record[field]) return;

    record[field] = await this.codec.decode(record[field] as Payload[]);
  }

  protected decodeMap(object: unknown, field: string): Promise<void>[] {
    if (!object) return [];
    const record = object as Record<string, unknown>;
    if (!record[field]) return [];

    return Object.entries(record[field] as Record<string, Payload>).map(async ([k, v]) => {
      const [decodedPayload] = await this.codec.decode([v]);
      (record[field] as Record<string, unknown>)[k] = decodedPayload;
    });
  }

  protected async decodeFailure(failureParent: unknown): Promise<void> {
    if (!failureParent) return;
    const accessibleFailureParent = failureParent as Record<string, unknown>;
    if (!accessibleFailureParent.failure) return;

    accessibleFailureParent.failure = await decodeFailure(
      this.codec,
      accessibleFailureParent.failure as temporal.api.failure.v1.IFailure
    );
  }

  /**
   * Run codec.encode on the Payloads inside the Completion message.
   */
  public async encodeCompletion(completionBytes: Uint8Array): Promise<Uint8Array> {
    const completion = coresdk.workflow_completion.WorkflowActivationCompletion.decode(completionBytes);

    await Promise.all([
      ...(completion.successful?.commands?.flatMap((command) =>
        command
          ? [
              ...this.encodeMap(command.scheduleActivity, 'headerFields'),
              this.encodeArray(command.scheduleActivity, 'arguments'),
              this.encodeField(command.respondToQuery?.succeeded, 'response'),
              this.encodeFailure(command.respondToQuery, 'failed'),
              this.encodeField(command.completeWorkflowExecution, 'result'),
              this.encodeFailure(command.failWorkflowExecution, 'failure'),
              this.encodeArray(command.continueAsNewWorkflowExecution, 'arguments'),
              ...this.encodeMap(command.continueAsNewWorkflowExecution, 'memo'),
              ...this.encodeMap(command.continueAsNewWorkflowExecution, 'header'),
              ...this.encodeMap(command.continueAsNewWorkflowExecution, 'searchAttributes'),
              this.encodeArray(command.startChildWorkflowExecution, 'input'),
              ...this.encodeMap(command.startChildWorkflowExecution, 'memo'),
              ...this.encodeMap(command.startChildWorkflowExecution, 'header'),
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
