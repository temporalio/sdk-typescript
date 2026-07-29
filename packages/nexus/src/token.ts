/**
 * Serializable token identifying a Nexus operation target.
 *
 * @internal
 * @hidden
 */
export interface OperationToken {
  /**
   * Version of the token, by default we assume we're on version 0, this field is not emitted as part of the output,
   * it's only used to reject newer token versions on load.
   */
  v?: number;

  /**
   * Type of the Operation.
   */
  t: OperationTokenType;

  /**
   * Namespace of the operation.
   */
  ns: string;

  /**
   * ID of the workflow.
   */
  wid?: string;
}

/**
 * An OperationToken that identifies a WorkflowRun operation.
 *
 * @internal
 * @hidden
 */
export interface WorkflowRunOperationToken extends OperationToken {
  t: typeof OperationTokenType.WORKFLOW_RUN;
  wid: string;
}

/**
 * OperationTokenType is used to identify the type of Operation token.
 * Currently, we only have one type of Operation token: WorkflowRun.
 *
 * @internal
 * @hidden
 */
export type OperationTokenType = (typeof OperationTokenType)[keyof typeof OperationTokenType];

/**
 * @internal
 * @hidden
 */
export const OperationTokenType = {
  WORKFLOW_RUN: 1,
} as const;

/**
 * Generate a workflow run Operation token.
 */
export function generateWorkflowRunOperationToken(namespace: string, workflowId: string): string {
  const token: WorkflowRunOperationToken = {
    t: OperationTokenType.WORKFLOW_RUN,
    ns: namespace,
    wid: workflowId,
  };
  return base64URLEncodeNoPadding(JSON.stringify(token));
}

/**
 * Load and validate the common fields of an Operation token.
 */
export function loadOperationToken(data: string): OperationToken {
  if (!data) {
    throw new TypeError('invalid operation token: token is empty');
  }

  let decoded: string;
  try {
    decoded = base64URLDecodeNoPadding(data);
  } catch (err) {
    throw new TypeError('failed to decode token', { cause: err });
  }

  let token: OperationToken;
  try {
    token = JSON.parse(decoded);
  } catch (err) {
    throw new TypeError('failed to unmarshal Operation token', { cause: err });
  }

  if (typeof token !== 'object' || token == null) {
    throw new TypeError(`invalid operation token: expected object, got ${typeof token}`);
  }
  if (token.v !== undefined && token.v !== 0) {
    throw new TypeError('invalid operation token: "v" field should not be present');
  }
  if (typeof token.t !== 'number') {
    throw new TypeError(`invalid operation token: expected token type to be a number, got ${typeof token.t}`);
  }
  if (!isOperationTokenType(token.t)) {
    throw new TypeError(`invalid operation token: unknown token type: ${token.t}`);
  }
  if (typeof token.ns !== 'string') {
    throw new TypeError(`invalid operation token: expected namespace to be a string, got ${typeof token.ns}`);
  }

  return token;
}

/**
 * Load and validate a workflow run Operation token.
 */
export function loadWorkflowRunOperationToken(data: string): WorkflowRunOperationToken {
  const token = loadOperationToken(data);
  assertWorkflowRunOperationToken(token);
  return token;
}

/**
 * Assert that an OperationToken identifies a workflow run.
 */
export function assertWorkflowRunOperationToken(token: OperationToken): asserts token is WorkflowRunOperationToken {
  if (token.t !== OperationTokenType.WORKFLOW_RUN) {
    throw new TypeError(`invalid workflow token type: ${token.t}, expected: ${OperationTokenType.WORKFLOW_RUN}`);
  }
  if (!token.wid || typeof token.wid !== 'string') {
    throw new TypeError('invalid workflow run token: missing workflow ID (wid)');
  }
}

function isOperationTokenType(value: number): value is OperationTokenType {
  return Object.values(OperationTokenType).includes(value as OperationTokenType);
}

// Exported for use in tests.
export function base64URLEncodeNoPadding(str: string): string {
  const base64 = Buffer.from(str).toString('base64url');
  return base64.replace(/[=]+$/, '');
}

function base64URLDecodeNoPadding(str: string): string {
  // Validate the string contains only valid base64URL characters
  if (!/^[A-Za-z0-9_-]*$/.test(str)) {
    throw new TypeError('invalid base64URL encoded string: contains invalid characters');
  }

  const paddingLength = str.length % 4;
  if (paddingLength > 0) {
    str += '='.repeat(4 - paddingLength);
  }

  return Buffer.from(str, 'base64url').toString('utf-8');
}
