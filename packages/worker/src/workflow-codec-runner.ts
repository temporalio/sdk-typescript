import type {
  ActivitySerializationContext,
  PayloadCodec,
  SerializationContext,
  WorkflowSerializationContext,
} from '@temporalio/common';
import type { Decoded, Encoded } from '@temporalio/common/lib/internal-non-workflow';
import {
  encode,
  decodeOptional,
  decodeOptionalFailure,
  decodeOptionalMap,
  decodeOptionalSingle,
  noopDecodeMap,
  visit,
  walkWorkflowActivationCompletion,
} from '@temporalio/common/lib/internal-non-workflow';
import { coresdk } from '@temporalio/proto';

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  private readonly pendingCompletionContexts = {
    activity: new Map<number, ActivitySerializationContext>(),
    childWorkflowStart: new Map<number, WorkflowSerializationContext>(),
    childWorkflowComplete: new Map<number, WorkflowSerializationContext>(),
    signalWorkflow: new Map<number, WorkflowSerializationContext>(),
    cancelWorkflow: new Map<number, WorkflowSerializationContext>(),
  };

  constructor(
    private readonly codecs: PayloadCodec[],
    public readonly workflowContext: WorkflowSerializationContext
  ) {}

  private consumeContext<TContext extends SerializationContext>(
    map: Map<number, TContext>,
    seq: number | null | undefined
  ): TContext | undefined {
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
    return coresdk.workflow_activation.WorkflowActivation.fromObject(<
      Decoded<coresdk.workflow_activation.IWorkflowActivation>
    >{
      ...activation,
      jobs: activation.jobs
        ? await Promise.all(
            activation.jobs.map(async (job) => {
              const resolveActivityContext = job.resolveActivity
                ? this.consumeContext(this.pendingCompletionContexts.activity, job.resolveActivity.seq)
                : undefined;
              const resolveChildWorkflowExecutionContext = job.resolveChildWorkflowExecution
                ? this.consumeContext(
                    this.pendingCompletionContexts.childWorkflowComplete,
                    job.resolveChildWorkflowExecution.seq
                  )
                : undefined;
              const resolveChildWorkflowStartContext = job.resolveChildWorkflowExecutionStart
                ? this.consumeContext(
                    this.pendingCompletionContexts.childWorkflowStart,
                    job.resolveChildWorkflowExecutionStart.seq
                  )
                : undefined;
              const resolveSignalContext = job.resolveSignalExternalWorkflow
                ? this.consumeContext(
                    this.pendingCompletionContexts.signalWorkflow,
                    job.resolveSignalExternalWorkflow.seq
                  )
                : undefined;
              const resolveCancelContext = job.resolveRequestCancelExternalWorkflow
                ? this.consumeContext(
                    this.pendingCompletionContexts.cancelWorkflow,
                    job.resolveRequestCancelExternalWorkflow.seq
                  )
                : undefined;

              return {
                ...job,
                initializeWorkflow: job.initializeWorkflow
                  ? {
                      ...job.initializeWorkflow,
                      arguments: await decodeOptional(
                        this.codecs,
                        job.initializeWorkflow.arguments,
                        this.workflowContext
                      ),
                      headers: noopDecodeMap(job.initializeWorkflow.headers),
                      continuedFailure: await decodeOptionalFailure(
                        this.codecs,
                        job.initializeWorkflow.continuedFailure,
                        this.workflowContext
                      ),
                      memo: {
                        ...job.initializeWorkflow.memo,
                        fields: await decodeOptionalMap(
                          this.codecs,
                          job.initializeWorkflow.memo?.fields,
                          this.workflowContext
                        ),
                      },
                      lastCompletionResult: {
                        ...job.initializeWorkflow.lastCompletionResult,
                        payloads: await decodeOptional(
                          this.codecs,
                          job.initializeWorkflow.lastCompletionResult?.payloads,
                          this.workflowContext
                        ),
                      },
                      searchAttributes: job.initializeWorkflow.searchAttributes
                        ? {
                            ...job.initializeWorkflow.searchAttributes,
                            indexedFields: job.initializeWorkflow.searchAttributes.indexedFields
                              ? noopDecodeMap(job.initializeWorkflow.searchAttributes.indexedFields)
                              : undefined,
                          }
                        : undefined,
                    }
                  : null,
                queryWorkflow: job.queryWorkflow
                  ? {
                      ...job.queryWorkflow,
                      arguments: await decodeOptional(this.codecs, job.queryWorkflow.arguments, this.workflowContext),
                      headers: noopDecodeMap(job.queryWorkflow.headers),
                    }
                  : null,
                doUpdate: job.doUpdate
                  ? {
                      ...job.doUpdate,
                      input: await decodeOptional(this.codecs, job.doUpdate.input, this.workflowContext),
                      headers: noopDecodeMap(job.doUpdate.headers),
                    }
                  : null,
                signalWorkflow: job.signalWorkflow
                  ? {
                      ...job.signalWorkflow,
                      input: await decodeOptional(this.codecs, job.signalWorkflow.input, this.workflowContext),
                      headers: noopDecodeMap(job.signalWorkflow.headers),
                    }
                  : null,
                resolveActivity: job.resolveActivity
                  ? {
                      ...job.resolveActivity,
                      result: job.resolveActivity.result
                        ? {
                            ...job.resolveActivity.result,
                            completed: job.resolveActivity.result.completed
                              ? {
                                  ...job.resolveActivity.result.completed,
                                  result: await decodeOptionalSingle(
                                    this.codecs,
                                    job.resolveActivity.result.completed.result,
                                    resolveActivityContext
                                  ),
                                }
                              : null,
                            failed: job.resolveActivity.result.failed
                              ? {
                                  ...job.resolveActivity.result.failed,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveActivity.result.failed.failure,
                                    resolveActivityContext
                                  ),
                                }
                              : null,
                            cancelled: job.resolveActivity.result.cancelled
                              ? {
                                  ...job.resolveActivity.result.cancelled,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveActivity.result.cancelled.failure,
                                    resolveActivityContext
                                  ),
                                }
                              : null,
                          }
                        : null,
                    }
                  : null,
                resolveChildWorkflowExecution: job.resolveChildWorkflowExecution
                  ? {
                      ...job.resolveChildWorkflowExecution,
                      result: job.resolveChildWorkflowExecution.result
                        ? {
                            ...job.resolveChildWorkflowExecution.result,
                            completed: job.resolveChildWorkflowExecution.result.completed
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.completed,
                                  result: await decodeOptionalSingle(
                                    this.codecs,
                                    job.resolveChildWorkflowExecution.result.completed.result,
                                    resolveChildWorkflowExecutionContext
                                  ),
                                }
                              : null,
                            failed: job.resolveChildWorkflowExecution.result.failed
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.failed,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveChildWorkflowExecution.result.failed.failure,
                                    resolveChildWorkflowExecutionContext
                                  ),
                                }
                              : null,
                            cancelled: job.resolveChildWorkflowExecution.result.cancelled
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.cancelled,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveChildWorkflowExecution.result.cancelled.failure,
                                    resolveChildWorkflowExecutionContext
                                  ),
                                }
                              : null,
                          }
                        : null,
                    }
                  : null,
                resolveChildWorkflowExecutionStart: job.resolveChildWorkflowExecutionStart
                  ? {
                      ...job.resolveChildWorkflowExecutionStart,
                      cancelled: job.resolveChildWorkflowExecutionStart.cancelled
                        ? {
                            ...job.resolveChildWorkflowExecutionStart.cancelled,
                            failure: await decodeOptionalFailure(
                              this.codecs,
                              job.resolveChildWorkflowExecutionStart.cancelled.failure,
                              resolveChildWorkflowStartContext
                            ),
                          }
                        : null,
                    }
                  : null,
                resolveNexusOperation: job.resolveNexusOperation
                  ? {
                      ...job.resolveNexusOperation,
                      result: {
                        completed: job.resolveNexusOperation.result?.completed
                          ? await decodeOptionalSingle(
                              this.codecs,
                              job.resolveNexusOperation.result.completed,
                              this.workflowContext
                            )
                          : null,
                        failed: job.resolveNexusOperation.result?.failed
                          ? await decodeOptionalFailure(
                              this.codecs,
                              job.resolveNexusOperation.result.failed,
                              this.workflowContext
                            )
                          : null,
                        cancelled: job.resolveNexusOperation.result?.cancelled
                          ? await decodeOptionalFailure(
                              this.codecs,
                              job.resolveNexusOperation.result.cancelled,
                              this.workflowContext
                            )
                          : null,
                        timedOut: job.resolveNexusOperation.result?.timedOut
                          ? await decodeOptionalFailure(
                              this.codecs,
                              job.resolveNexusOperation.result.timedOut,
                              this.workflowContext
                            )
                          : null,
                      },
                    }
                  : null,
                resolveSignalExternalWorkflow: job.resolveSignalExternalWorkflow
                  ? {
                      ...job.resolveSignalExternalWorkflow,
                      failure: await decodeOptionalFailure(
                        this.codecs,
                        job.resolveSignalExternalWorkflow.failure,
                        resolveSignalContext
                      ),
                    }
                  : null,
                resolveRequestCancelExternalWorkflow: job.resolveRequestCancelExternalWorkflow
                  ? {
                      ...job.resolveRequestCancelExternalWorkflow,
                      failure: await decodeOptionalFailure(
                        this.codecs,
                        job.resolveRequestCancelExternalWorkflow.failure,
                        resolveCancelContext
                      ),
                    }
                  : null,
              };
            })
          )
        : null,
    }) as Decoded<T>;
  }

  /**
   * Run codec.encode on the Payloads inside the Completion message.
   */
  public async encodeCompletion(
    completion: coresdk.workflow_completion.IWorkflowActivationCompletion
  ): Promise<Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>> {
    const encodedCompletion = coresdk.workflow_completion.WorkflowActivationCompletion.fromObject(completion);
    await visit<coresdk.workflow_completion.IWorkflowActivationCompletion, SerializationContext>(
      encodedCompletion,
      walkWorkflowActivationCompletion,
      {
        transformPayload: async (payload, context) => (await encode(this.codecs, [payload], context))[0]!,
        transformPayloads: (payloads, context) => encode(this.codecs, payloads, context),
        initialContext: this.workflowContext,
        // Headers and search attributes are not payload-converted by workflows.
        skipHeaders: true,
        skipSearchAttributes: true,
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
    return encodedCompletion as unknown as Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>;
  }
}
