import type {
  SandboxClient,
  SandboxClientCreateArgs,
  SandboxClientOptions,
  SandboxClientResumeOptions,
  SandboxSessionLike,
  SandboxSessionSerializationOptions,
} from '@openai/agents-core/sandbox';
import { Manifest } from '@openai/agents-core/sandbox';
import { ApplicationFailure, type ActivityOptions } from '@temporalio/common';
import { scheduleActivity } from '@temporalio/workflow';
import {
  SANDBOX_CLIENT_CREATE_SUFFIX,
  SANDBOX_CLIENT_DELETE_SUFFIX,
  SANDBOX_CLIENT_RESUME_SUFFIX,
  SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX,
  decodeManifest,
  encodeManifest,
  reviveWorkflowSessionState,
  sandboxSpanName,
  serializeSessionEnvelope,
  type EncodedManifest,
  type SandboxSessionResult,
  type SerializedSandboxSessionState,
  type TemporalSandboxSessionState,
} from '../common/sandbox-activity-types';
import { TemporalSandboxSession } from './sandbox-session';
import { maybeTemporalSpan } from './span-helpers';

/**
 * Workflow-side sandbox client. Holds no connection to any sandbox backend —
 * session creation, resumption, and every session operation are dispatched as
 * Activities to the `SandboxClientProvider` registered under the same name on
 * the Worker.
 *
 * Create instances via {@link temporalSandboxClient}.
 */
export class TemporalSandboxClient implements SandboxClient<SandboxClientOptions, TemporalSandboxSessionState> {
  readonly backendId: string;
  private readonly _name: string;
  private readonly _config: ActivityOptions;

  constructor(name: string, config?: ActivityOptions) {
    this._name = name;
    this.backendId = name;
    this._config = config ?? { startToCloseTimeout: '5 minutes' };
  }

  async create(
    argsOrManifest?: SandboxClientCreateArgs | Manifest,
    manifestOptions?: SandboxClientOptions
  ): Promise<SandboxSessionLike<TemporalSandboxSessionState>> {
    const args: SandboxClientCreateArgs =
      argsOrManifest instanceof Manifest
        ? { manifest: argsOrManifest, options: manifestOptions }
        : argsOrManifest ?? {};
    let manifest: EncodedManifest | undefined;
    if (args.manifest !== undefined) {
      manifest = encodeManifest(args.manifest instanceof Manifest ? args.manifest : new Manifest(args.manifest));
    }
    const result = await scheduleActivity<SandboxSessionResult>(
      `${this._name}${SANDBOX_CLIENT_CREATE_SUFFIX}`,
      [
        {
          manifest,
          snapshot: args.snapshot,
          options: args.options,
          concurrencyLimits: args.concurrencyLimits,
          archiveLimits: args.archiveLimits,
        },
      ],
      this._config
    );
    return this.wrapSession(result);
  }

  async resume(
    state: TemporalSandboxSessionState,
    options?: SandboxClientResumeOptions
  ): Promise<SandboxSessionLike<TemporalSandboxSessionState>> {
    const result = await maybeTemporalSpan(
      sandboxSpanName(SANDBOX_CLIENT_RESUME_SUFFIX),
      () =>
        scheduleActivity<SandboxSessionResult>(
          `${this._name}${SANDBOX_CLIENT_RESUME_SUFFIX}`,
          [
            {
              state: serializeSessionEnvelope(state.sessionId, state, state.providerState),
              archiveLimits: options?.archiveLimits,
            },
          ],
          this._config
        ),
      { sessionId: state.sessionId }
    );
    return this.wrapSession(result);
  }

  async delete(state: TemporalSandboxSessionState): Promise<void> {
    await maybeTemporalSpan(
      sandboxSpanName(SANDBOX_CLIENT_DELETE_SUFFIX),
      () =>
        scheduleActivity<void>(
          `${this._name}${SANDBOX_CLIENT_DELETE_SUFFIX}`,
          [{ state: serializeSessionEnvelope(state.sessionId, state, state.providerState) }],
          this._config
        ),
      { sessionId: state.sessionId }
    );
  }

  async serializeSessionState(
    state: TemporalSandboxSessionState,
    options?: SandboxSessionSerializationOptions
  ): Promise<Record<string, unknown>> {
    const refreshed = await maybeTemporalSpan(
      sandboxSpanName(SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX),
      () =>
        scheduleActivity<SerializedSandboxSessionState>(
          `${this._name}${SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX}`,
          [{ state: serializeSessionEnvelope(state.sessionId, state, state.providerState), options }],
          this._config
        ),
      { sessionId: state.sessionId }
    );
    const revived = reviveWorkflowSessionState(refreshed);
    if ('snapshot' in revived) state.snapshot = revived.snapshot;
    else delete state.snapshot;
    if ('snapshotFingerprint' in revived) state.snapshotFingerprint = revived.snapshotFingerprint;
    else delete state.snapshotFingerprint;
    if ('snapshotFingerprintVersion' in revived) state.snapshotFingerprintVersion = revived.snapshotFingerprintVersion;
    else delete state.snapshotFingerprintVersion;
    if ('exposedPorts' in revived) state.exposedPorts = revived.exposedPorts;
    else delete state.exposedPorts;
    state.sessionId = revived.sessionId;
    state.manifest = revived.manifest;
    if ('workspaceReady' in revived) state.workspaceReady = revived.workspaceReady;
    else delete state.workspaceReady;
    state.providerState = revived.providerState;
    return { sessionId: refreshed.sessionId, providerState: refreshed.providerState };
  }

  async deserializeSessionState(state: Record<string, unknown>): Promise<TemporalSandboxSessionState> {
    const { sessionId, providerState, manifest, ...rest } = state;
    if (typeof sessionId !== 'string') {
      throw ApplicationFailure.create({
        message:
          'Serialized sandbox session state is missing a sessionId — it was not produced by a Temporal sandbox client.',
        type: 'SandboxSessionStateInvalid',
        nonRetryable: true,
      });
    }
    if (manifest == null) {
      throw ApplicationFailure.create({
        message:
          'Serialized sandbox session state is missing a manifest — it was not produced by a Temporal sandbox client.',
        type: 'SandboxSessionStateInvalid',
        nonRetryable: true,
      });
    }
    return {
      ...rest,
      sessionId,
      providerState: (providerState ?? {}) as Record<string, unknown>,
      manifest: decodeManifest(manifest as EncodedManifest),
    };
  }

  private wrapSession(result: SandboxSessionResult): TemporalSandboxSession {
    return new TemporalSandboxSession(
      this._name,
      this._config,
      reviveWorkflowSessionState(result.state),
      result.supportsPty
    );
  }
}

/**
 * Creates a Workflow-side sandbox client for `RunConfig.sandbox`. All sandbox
 * operations are dispatched as Activities to the `SandboxClientProvider`
 * registered under the same name on the Worker.
 *
 * When `config` is omitted, Activities use a five-minute start-to-close timeout.
 * A supplied `ActivityOptions` object is used as-is without merging defaults.
 *
 * @param name - Provider name; must match the `SandboxClientProvider` registered on the Worker side.
 * @param config - Activity options for every sandbox operation.
 */
export function temporalSandboxClient(name: string, config?: ActivityOptions): TemporalSandboxClient {
  return new TemporalSandboxClient(name, config);
}
