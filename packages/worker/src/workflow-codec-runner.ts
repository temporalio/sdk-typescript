import type {
  ActivitySerializationContext,
  PayloadCodec,
  SerializationContext,
  WorkflowSerializationContext,
} from '@temporalio/common';
import type { Decoded, Encoded } from '@temporalio/common/lib/internal-non-workflow';
import {
  decode,
  encode,
  visit,
  walkWorkflowActivation,
  walkWorkflowActivationCompletion,
} from '@temporalio/common/lib/internal-non-workflow';
import { limit } from '@temporalio/common/lib/concurrency/limit';
import { coresdk } from '@temporalio/proto';
import {
  decodeSystemNexusOutput,
  encodeSystemNexusInput,
  isSystemNexusEnvelope,
} from './system-nexus-payload-converter';

/**
 * Maximum number of concurrent codec calls per activation or completion.
 */
const MAX_CONCURRENT_CODEC_OPERATIONS = 20;

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  private readonly codecOperationLimit = limit(MAX_CONCURRENT_CODEC_OPERATIONS);

  private readonly pendingCompletionContexts = {
    activity: new Map<number, ActivitySerializationContext>(),
    childWorkflowStart: new Map<number, WorkflowSerializationContext>(),
    childWorkflowComplete: new Map<number, WorkflowSerializationContext>(),
    signalWorkflow: new Map<number, WorkflowSerializationContext>(),
    cancelWorkflow: new Map<number, WorkflowSerializationContext>(),
    nexusOperation: new Map<number, { service: string; operation: string; context: SerializationContext }>(),
  };

  constructor(
    private readonly codecs: PayloadCodec[],
    public readonly workflowContext: WorkflowSerializationContext
  ) {}

  private consumeContext<TContext>(map: Map<number, TContext>, seq: number | null | undefined): TContext | undefined {
    if (seq == null) return undefined;
    const context = map.get(seq);
    if (context !== undefined) {
      map.delete(seq);
    }
    return context;
  }

  private activityContext(
    command: coresdk.workflow_commands.IScheduleActivity | coresdk.workflow_commands.IScheduleLocalActivity,
    isLocal: boolean
  ): ActivitySerializationContext {
    return {
      type: 'activity',
      namespace: this.workflowContext.namespace,
      workflowId: this.workflowContext.workflowId,
      activityId: command.activityId || undefined,
      isLocal,
    };
  }

  private childWorkflowContext(
    command: coresdk.workflow_commands.IStartChildWorkflowExecution
  ): WorkflowSerializationContext | undefined {
    if (command.workflowId == null) return undefined;
    return {
      type: 'workflow',
      namespace: command.namespace || this.workflowContext.namespace,
      workflowId: command.workflowId,
    };
  }

  private externalWorkflowContext(
    command:
      | coresdk.workflow_commands.ISignalExternalWorkflowExecution
      | coresdk.workflow_commands.IRequestCancelExternalWorkflowExecution
  ): WorkflowSerializationContext | undefined {
    const workflowId =
      command.workflowExecution?.workflowId ?? ('childWorkflowId' in command ? command.childWorkflowId : undefined);
    if (workflowId == null) return undefined;
    return {
      type: 'workflow',
      namespace: command.workflowExecution?.namespace || this.workflowContext.namespace,
      workflowId,
    };
  }

  /**
   * Run codec.decode on the Payloads in the Activation message.
   */
  public async decodeActivation<T extends coresdk.workflow_activation.IWorkflowActivation>(
    activation: T
  ): Promise<Decoded<T>> {
    const decodedActivation = coresdk.workflow_activation.WorkflowActivation.fromObject(activation);
    const systemOutputs: Array<{
      result: coresdk.nexus.INexusOperationResult;
      payload: import('@temporalio/common').Payload;
      info: { service: string; operation: string; context: SerializationContext };
    }> = [];
    for (const job of decodedActivation.jobs ?? []) {
      const resolve = job.resolveNexusOperation;
      const seq = resolve?.seq;
      const info = seq == null ? undefined : this.consumeContext(this.pendingCompletionContexts.nexusOperation, seq);
      const payload = resolve?.result?.completed;
      if (resolve?.result != null && payload != null && info != null) {
        systemOutputs.push({ result: resolve.result, payload, info });
        resolve.result.completed = undefined;
      }
    }
    await visit<coresdk.workflow_activation.IWorkflowActivation, SerializationContext | undefined>(
      decodedActivation,
      walkWorkflowActivation,
      {
        transformPayload: async (payload, context) => (await decode(this.codecs, [payload], context))[0]!,
        transformPayloads: (payloads, context) => decode(this.codecs, payloads, context),
        initialContext: this.workflowContext,
        skipHeaders: true,
        skipSearchAttributes: true,
        limit: this.codecOperationLimit,
        deriveContext: (message, typeName, context) => {
          switch (typeName) {
            case 'coresdk.workflow_activation.ResolveActivity':
              return this.consumeContext(
                this.pendingCompletionContexts.activity,
                (message as coresdk.workflow_activation.IResolveActivity).seq
              );
            case 'coresdk.workflow_activation.ResolveChildWorkflowExecution':
              return this.consumeContext(
                this.pendingCompletionContexts.childWorkflowComplete,
                (message as coresdk.workflow_activation.IResolveChildWorkflowExecution).seq
              );
            case 'coresdk.workflow_activation.ResolveChildWorkflowExecutionStart':
              return this.consumeContext(
                this.pendingCompletionContexts.childWorkflowStart,
                (message as coresdk.workflow_activation.IResolveChildWorkflowExecutionStart).seq
              );
            case 'coresdk.workflow_activation.ResolveSignalExternalWorkflow':
              return this.consumeContext(
                this.pendingCompletionContexts.signalWorkflow,
                (message as coresdk.workflow_activation.IResolveSignalExternalWorkflow).seq
              );
            case 'coresdk.workflow_activation.ResolveRequestCancelExternalWorkflow':
              return this.consumeContext(
                this.pendingCompletionContexts.cancelWorkflow,
                (message as coresdk.workflow_activation.IResolveRequestCancelExternalWorkflow).seq
              );
            default:
              return context;
          }
        },
      }
    );
    for (const output of systemOutputs) {
      output.result.completed = await decodeSystemNexusOutput(
        this.codecs,
        output.info.service,
        output.info.operation,
        output.payload,
        output.info.context
      );
    }
    return decodedActivation as unknown as Decoded<T>;
  }

  /**
   * Run codec.encode on the Payloads inside the Completion message.
   */
  public async encodeCompletion(
    completion: coresdk.workflow_completion.IWorkflowActivationCompletion
  ): Promise<Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>> {
    const encodedCompletion = coresdk.workflow_completion.WorkflowActivationCompletion.fromObject(completion);
    const systemInputs: Array<{
      command: coresdk.workflow_commands.IScheduleNexusOperation;
      payload: import('@temporalio/common').Payload;
    }> = [];
    for (const command of encodedCompletion.successful?.commands ?? []) {
      const schedule = command.scheduleNexusOperation;
      if (schedule?.input != null && isSystemNexusEnvelope(schedule.endpoint, schedule.input)) {
        systemInputs.push({ command: schedule, payload: schedule.input });
        schedule.input = undefined;
      }
    }
    await visit<coresdk.workflow_completion.IWorkflowActivationCompletion, SerializationContext>(
      encodedCompletion,
      walkWorkflowActivationCompletion,
      {
        transformPayload: async (payload, context) => (await encode(this.codecs, [payload], context))[0]!,
        transformPayloads: (payloads, context) => encode(this.codecs, payloads, context),
        initialContext: this.workflowContext,
        skipHeaders: true,
        skipSearchAttributes: true,
        limit: this.codecOperationLimit,
        deriveContext: (message, typeName, context) => {
          if (typeName !== 'coresdk.workflow_commands.WorkflowCommand') {
            if (typeName === 'coresdk.workflow_commands.ScheduleActivity') {
              return this.activityContext(message as coresdk.workflow_commands.IScheduleActivity, false);
            }
            if (typeName === 'coresdk.workflow_commands.ScheduleLocalActivity') {
              return this.activityContext(message as coresdk.workflow_commands.IScheduleLocalActivity, true);
            }
            if (typeName === 'coresdk.workflow_commands.StartChildWorkflowExecution') {
              return (
                this.childWorkflowContext(message as coresdk.workflow_commands.IStartChildWorkflowExecution) ?? context
              );
            }
            if (typeName === 'coresdk.workflow_commands.SignalExternalWorkflowExecution') {
              return (
                this.externalWorkflowContext(message as coresdk.workflow_commands.ISignalExternalWorkflowExecution) ??
                context
              );
            }
            return context;
          }

          const command = message as coresdk.workflow_commands.IWorkflowCommand;
          let userMetadataContext: SerializationContext = this.workflowContext;
          const scheduleActivity = command.scheduleActivity;
          if (scheduleActivity?.seq != null) {
            const activityContext = this.activityContext(scheduleActivity, false);
            this.pendingCompletionContexts.activity.set(scheduleActivity.seq, activityContext);
            userMetadataContext = activityContext;
          }
          const scheduleLocalActivity = command.scheduleLocalActivity;
          if (scheduleLocalActivity?.seq != null) {
            const activityContext = this.activityContext(scheduleLocalActivity, true);
            this.pendingCompletionContexts.activity.set(scheduleLocalActivity.seq, activityContext);
            userMetadataContext = activityContext;
          }
          const startChild = command.startChildWorkflowExecution;
          const childContext = startChild ? this.childWorkflowContext(startChild) : undefined;
          if (startChild?.seq != null && childContext) {
            this.pendingCompletionContexts.childWorkflowStart.set(startChild.seq, childContext);
            this.pendingCompletionContexts.childWorkflowComplete.set(startChild.seq, childContext);
            userMetadataContext = childContext;
          }
          const signal = command.signalExternalWorkflowExecution;
          const signalContext = signal ? this.externalWorkflowContext(signal) : undefined;
          if (signal?.seq != null && signalContext) {
            this.pendingCompletionContexts.signalWorkflow.set(signal.seq, signalContext);
          }
          const cancel = command.requestCancelExternalWorkflowExecution;
          const cancelContext = cancel ? this.externalWorkflowContext(cancel) : undefined;
          if (cancel?.seq != null && cancelContext) {
            this.pendingCompletionContexts.cancelWorkflow.set(cancel.seq, cancelContext);
          }
          return userMetadataContext;
        },
      }
    );
    for (const input of systemInputs) {
      const encoded = await encodeSystemNexusInput(
        this.codecs,
        input.command.service,
        input.command.operation,
        input.payload,
        this.workflowContext
      );
      if (encoded == null) {
        input.command.input = input.payload;
        continue;
      }
      input.command.input = encoded.payload;
      if (input.command.seq != null) {
        this.pendingCompletionContexts.nexusOperation.set(input.command.seq, {
          service: input.command.service!,
          operation: input.command.operation!,
          context: encoded.context ?? this.workflowContext,
        });
      }
    }
    return encodedCompletion as unknown as Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>;
  }
}
