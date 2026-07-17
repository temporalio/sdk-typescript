import type { ApplyPatchOperation, ToolOutputImage } from '@openai/agents-core';
import type {
  Entry,
  ExecCommandArgs,
  ExposedPortEndpoint,
  ListDirectoryArgs,
  ReadFileArgs,
  SandboxArchiveLimits,
  SandboxConcurrencyLimits,
  SandboxGroup,
  SandboxPathGrant,
  SandboxSessionLifecycleOptions,
  SandboxSessionSerializationOptions,
  SandboxSessionState,
  SandboxUser,
  Snapshot,
  SnapshotSpec,
  ViewImageArgs,
  WriteStdinArgs,
} from '@openai/agents-core/sandbox';
import { Manifest } from '@openai/agents-core/sandbox';

export const SANDBOX_CLIENT_CREATE_SUFFIX = '-sandbox-client-create';
export const SANDBOX_CLIENT_RESUME_SUFFIX = '-sandbox-client-resume';
export const SANDBOX_CLIENT_DELETE_SUFFIX = '-sandbox-client-delete';
export const SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX = '-sandbox-client-serialize-session-state';
export const SANDBOX_SESSION_START_SUFFIX = '-sandbox-session-start';
export const SANDBOX_SESSION_RUNNING_SUFFIX = '-sandbox-session-running';
export const SANDBOX_SESSION_STOP_SUFFIX = '-sandbox-session-stop';
export const SANDBOX_SESSION_SHUTDOWN_SUFFIX = '-sandbox-session-shutdown';
export const SANDBOX_SESSION_DELETE_SUFFIX = '-sandbox-session-delete';
export const SANDBOX_SESSION_EXEC_SUFFIX = '-sandbox-session-exec';
export const SANDBOX_SESSION_EXEC_COMMAND_SUFFIX = '-sandbox-session-exec-command';
export const SANDBOX_SESSION_WRITE_STDIN_SUFFIX = '-sandbox-session-write-stdin';
export const SANDBOX_SESSION_VIEW_IMAGE_SUFFIX = '-sandbox-session-view-image';
export const SANDBOX_SESSION_READ_FILE_SUFFIX = '-sandbox-session-read-file';
export const SANDBOX_SESSION_LIST_DIR_SUFFIX = '-sandbox-session-list-dir';
export const SANDBOX_SESSION_PATH_EXISTS_SUFFIX = '-sandbox-session-path-exists';
export const SANDBOX_SESSION_MATERIALIZE_ENTRY_SUFFIX = '-sandbox-session-materialize-entry';
export const SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX = '-sandbox-session-apply-manifest';
export const SANDBOX_SESSION_PERSIST_WORKSPACE_SUFFIX = '-sandbox-session-persist-workspace';
export const SANDBOX_SESSION_HYDRATE_WORKSPACE_SUFFIX = '-sandbox-session-hydrate-workspace';
export const SANDBOX_SESSION_RESOLVE_EXPOSED_PORT_SUFFIX = '-sandbox-session-resolve-exposed-port';
export const SANDBOX_EDITOR_CREATE_FILE_SUFFIX = '-sandbox-editor-create-file';
export const SANDBOX_EDITOR_UPDATE_FILE_SUFFIX = '-sandbox-editor-update-file';
export const SANDBOX_EDITOR_DELETE_FILE_SUFFIX = '-sandbox-editor-delete-file';

export const SANDBOX_ACTIVITY_SUFFIXES = [
  SANDBOX_CLIENT_CREATE_SUFFIX,
  SANDBOX_CLIENT_RESUME_SUFFIX,
  SANDBOX_CLIENT_DELETE_SUFFIX,
  SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX,
  SANDBOX_SESSION_START_SUFFIX,
  SANDBOX_SESSION_RUNNING_SUFFIX,
  SANDBOX_SESSION_STOP_SUFFIX,
  SANDBOX_SESSION_SHUTDOWN_SUFFIX,
  SANDBOX_SESSION_DELETE_SUFFIX,
  SANDBOX_SESSION_EXEC_SUFFIX,
  SANDBOX_SESSION_EXEC_COMMAND_SUFFIX,
  SANDBOX_SESSION_WRITE_STDIN_SUFFIX,
  SANDBOX_SESSION_VIEW_IMAGE_SUFFIX,
  SANDBOX_SESSION_READ_FILE_SUFFIX,
  SANDBOX_SESSION_LIST_DIR_SUFFIX,
  SANDBOX_SESSION_PATH_EXISTS_SUFFIX,
  SANDBOX_SESSION_MATERIALIZE_ENTRY_SUFFIX,
  SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX,
  SANDBOX_SESSION_PERSIST_WORKSPACE_SUFFIX,
  SANDBOX_SESSION_HYDRATE_WORKSPACE_SUFFIX,
  SANDBOX_SESSION_RESOLVE_EXPOSED_PORT_SUFFIX,
  SANDBOX_EDITOR_CREATE_FILE_SUFFIX,
  SANDBOX_EDITOR_UPDATE_FILE_SUFFIX,
  SANDBOX_EDITOR_DELETE_FILE_SUFFIX,
] as const;

/**
 * JSON-safe representation of the full manifest: binary file contents are
 * base64-encoded with the `{ type: 'base64', data }` marker. The entire manifest
 * is preserved — including ephemeral files, dirs, mounts, and ephemeral
 * environment values — so it reaches the backend unchanged and appears in
 * Temporal history.
 */
export interface EncodedManifest {
  version: number;
  root: string;
  entries: Record<string, unknown>;
  environment: Record<string, EncodedEnvValue>;
  users: SandboxUser[];
  groups: SandboxGroup[];
  extraPathGrants: SandboxPathGrant[];
  remoteMountCommandAllowlist: string[];
}

export interface EncodedEnvValue {
  value: string;
  ephemeral?: boolean;
  description?: string;
}

/**
 * The serializable sandbox-session handle that crosses the Workflow/Activity
 * boundary. Holds only identifiers, the encoded manifest, and the real client's
 * own serialized state — never workspace bytes.
 */
export interface SerializedSandboxSessionState {
  /** Worker-side session-cache key, assigned when the session is created. */
  sessionId: string;
  manifest: EncodedManifest;
  snapshot?: Snapshot | null;
  snapshotFingerprint?: string | null;
  snapshotFingerprintVersion?: string | null;
  workspaceReady?: boolean;
  exposedPorts?: Record<string, ExposedPortEndpoint>;
  /** Output of the real client's `serializeSessionState`. */
  providerState: Record<string, unknown>;
}

/** Workflow-side session state: the serialized handle with a live `Manifest`. */
export interface TemporalSandboxSessionState extends SandboxSessionState {
  sessionId: string;
  providerState: Record<string, unknown>;
}

export interface SandboxSessionResult {
  state: SerializedSandboxSessionState;
  supportsPty: boolean;
}

export interface SandboxCreateSessionInput {
  manifest?: EncodedManifest;
  snapshot?: SnapshotSpec;
  options?: Record<string, unknown>;
  concurrencyLimits?: SandboxConcurrencyLimits;
  archiveLimits?: SandboxArchiveLimits | null;
}

export interface SandboxResumeSessionInput {
  state: SerializedSandboxSessionState;
  archiveLimits?: SandboxArchiveLimits | null;
}

export interface SandboxSessionStateInput {
  state: SerializedSandboxSessionState;
}

export interface SandboxSerializeSessionStateInput extends SandboxSessionStateInput {
  options?: SandboxSessionSerializationOptions;
}

export interface SandboxLifecycleInput extends SandboxSessionStateInput {
  options?: SandboxSessionLifecycleOptions;
}

export interface SandboxExecInput extends SandboxSessionStateInput {
  args: ExecCommandArgs;
}

export interface SandboxWriteStdinInput extends SandboxSessionStateInput {
  args: WriteStdinArgs;
}

export interface SandboxViewImageInput extends SandboxSessionStateInput {
  args: ViewImageArgs;
}

export interface SandboxReadFileInput extends SandboxSessionStateInput {
  args: ReadFileArgs;
}

export interface SandboxListDirInput extends SandboxSessionStateInput {
  args: ListDirectoryArgs;
}

export interface SandboxPathExistsInput extends SandboxSessionStateInput {
  path: string;
  runAs?: string;
}

export interface SandboxMaterializeEntryInput extends SandboxSessionStateInput {
  path: string;
  entry: unknown;
  runAs?: string;
}

export interface SandboxApplyManifestInput extends SandboxSessionStateInput {
  manifest: EncodedManifest;
  runAs?: string;
}

export interface SandboxPersistWorkspaceInput extends SandboxSessionStateInput {
  archiveLimits?: SandboxArchiveLimits | null;
}

/** Archive bytes travel as a separate top-level Activity argument. */
export interface SandboxHydrateWorkspaceInput extends SandboxSessionStateInput {
  archiveLimits?: SandboxArchiveLimits | null;
}

export interface SandboxResolveExposedPortInput extends SandboxSessionStateInput {
  port: number;
}

export interface SandboxEditorInput extends SandboxSessionStateInput {
  operation: ApplyPatchOperation;
  runAs?: string;
}

export interface SerializedToolOutputImage {
  output: ToolOutputImage;
  /** Set when the original `image.data` was binary and base64-encoded for transport. */
  imageDataBase64?: boolean;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += BASE64_ALPHABET[b0 >> 2]!;
    result += BASE64_ALPHABET[((b0 & 0x3) << 4) | ((b1 ?? 0) >> 4)]!;
    result += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0xf) << 2) | ((b2 ?? 0) >> 6)]!;
    result += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f]!;
  }
  return result;
}

export function base64ToBytes(value: string): Uint8Array {
  const stripped = value.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((stripped.length * 3) / 4));
  let byteIndex = 0;
  for (let i = 0; i < stripped.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(stripped[i]!);
    const c1 = BASE64_ALPHABET.indexOf(stripped[i + 1] ?? 'A');
    const c2 = stripped[i + 2] === undefined ? -1 : BASE64_ALPHABET.indexOf(stripped[i + 2]!);
    const c3 = stripped[i + 3] === undefined ? -1 : BASE64_ALPHABET.indexOf(stripped[i + 3]!);
    bytes[byteIndex++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) bytes[byteIndex++] = ((c1 & 0xf) << 4) | (c2 >> 2);
    if (c3 >= 0) bytes[byteIndex++] = ((c2 & 0x3) << 6) | c3;
  }
  return bytes;
}

interface SerializedFileContent {
  type: 'base64';
  data: string;
}

function isSerializedFileContent(value: unknown): value is SerializedFileContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as SerializedFileContent).type === 'base64' &&
    typeof (value as SerializedFileContent).data === 'string'
  );
}

export function encodeEntry(entry: Entry): unknown {
  if (entry.type === 'file' && entry.content instanceof Uint8Array) {
    return { ...entry, content: { type: 'base64', data: bytesToBase64(entry.content) } };
  }
  if (entry.type === 'dir' && entry.children) {
    return { ...entry, children: encodeEntries(entry.children) };
  }
  return entry;
}

export function decodeEntry(entry: unknown): Entry {
  const record = entry as { type?: string; content?: unknown; children?: Record<string, unknown> };
  if (record.type === 'file' && isSerializedFileContent(record.content)) {
    return { ...record, content: base64ToBytes(record.content.data) } as Entry;
  }
  if (record.type === 'dir' && record.children) {
    return { ...record, children: decodeEntries(record.children) } as Entry;
  }
  return entry as Entry;
}

function encodeEntries(entries: Record<string, Entry>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).map(([path, entry]) => [path, encodeEntry(entry)]));
}

function decodeEntries(entries: Record<string, unknown>): Record<string, Entry> {
  return Object.fromEntries(Object.entries(entries).map(([path, entry]) => [path, decodeEntry(entry)]));
}

/**
 * Used instead of the SDK's own serializer because the SDK's
 * `@openai/agents-core/sandbox/internal` barrel imports Node built-ins and
 * cannot be bundled into the Workflow isolate.
 */
export function encodeManifest(manifest: Manifest): EncodedManifest {
  const environment: Record<string, EncodedEnvValue> = {};
  for (const [key, env] of Object.entries(manifest.environment)) {
    const normalized = env.normalized();
    environment[key] = {
      value: normalized.value,
      ...(normalized.ephemeral ? { ephemeral: true } : {}),
      ...(normalized.description !== undefined ? { description: normalized.description } : {}),
    };
  }
  return {
    version: manifest.version,
    root: manifest.root,
    entries: encodeEntries(manifest.entries),
    environment,
    users: manifest.users,
    groups: manifest.groups,
    extraPathGrants: manifest.extraPathGrants,
    remoteMountCommandAllowlist: manifest.remoteMountCommandAllowlist,
  };
}

export function decodeManifest(encoded: EncodedManifest): Manifest {
  return new Manifest({
    version: encoded.version,
    root: encoded.root,
    entries: decodeEntries(encoded.entries),
    environment: encoded.environment,
    users: encoded.users,
    groups: encoded.groups,
    extraPathGrants: encoded.extraPathGrants,
    remoteMountCommandAllowlist: encoded.remoteMountCommandAllowlist,
  });
}

/** Builds the transported session handle, with the manifest encoded via {@link encodeManifest}. */
export function serializeSessionEnvelope(
  sessionId: string,
  state: SandboxSessionState,
  providerState: Record<string, unknown>
): SerializedSandboxSessionState {
  return {
    sessionId,
    manifest: encodeManifest(state.manifest),
    ...(state.snapshot !== undefined ? { snapshot: state.snapshot } : {}),
    ...(state.snapshotFingerprint !== undefined ? { snapshotFingerprint: state.snapshotFingerprint } : {}),
    ...(state.snapshotFingerprintVersion !== undefined
      ? { snapshotFingerprintVersion: state.snapshotFingerprintVersion }
      : {}),
    workspaceReady: state.workspaceReady ?? true,
    ...(state.exposedPorts ? { exposedPorts: state.exposedPorts } : {}),
    providerState,
  };
}

/** Revives the Workflow-side session state, with a live `Manifest` for the run loop. */
export function reviveWorkflowSessionState(payload: SerializedSandboxSessionState): TemporalSandboxSessionState {
  const { sessionId, manifest, providerState, ...rest } = payload;
  return { ...rest, sessionId, providerState: providerState ?? {}, manifest: decodeManifest(manifest) };
}

/**
 * Builds the record a real client's `deserializeSessionState`/`resume` expects:
 * the provider state merged under the SDK envelope fields, matching the SDK's
 * own resume path.
 */
export function toSdkStateRecord(payload: SerializedSandboxSessionState): Record<string, unknown> {
  const { sessionId: _sessionId, manifest, providerState, ...rest } = payload;
  return { ...(providerState ?? {}), ...rest, manifest };
}

export function encodeToolOutputImage(output: ToolOutputImage): SerializedToolOutputImage {
  const image = output.image;
  if (typeof image === 'object' && image !== null && 'data' in image && image.data instanceof Uint8Array) {
    return {
      output: { ...output, image: { ...image, data: bytesToBase64(image.data) } },
      imageDataBase64: true,
    };
  }
  return { output };
}

export function decodeToolOutputImage(serialized: SerializedToolOutputImage): ToolOutputImage {
  if (!serialized.imageDataBase64) return serialized.output;
  const image = serialized.output.image as { data: string };
  return { ...serialized.output, image: { ...image, data: base64ToBytes(image.data) } };
}
