const OPERATION_TOKEN_TYPE_WORKFLOW_RUN = 1;

// OperationTokenType is used to identify the type of operation token.
// Currently, we only have one type of operation token: WorkflowRun.
type OperationTokenType = typeof OPERATION_TOKEN_TYPE_WORKFLOW_RUN;

interface WorkflowRunOperationToken {
  // Version of the token, by default we assume we're on version 1, this field is not emitted as part of the output,
  // it's only used to reject newer token versions on load.
  v?: number;
  // Type of the operation. Must be OPERATION_TOKEN_TYPE_WORKFLOW_RUN.
  t: OperationTokenType;
  ns: string;
  wid: string;
}

/**
 * Generate a workflow run operation token.
 */
export function generateWorkflowRunOperationToken(namespace: string, workflowID: string): string {
  const token: WorkflowRunOperationToken = {
    t: OPERATION_TOKEN_TYPE_WORKFLOW_RUN,
    ns: namespace,
    wid: workflowID,
  };
  return base64URLEncodeNoPadding(JSON.stringify(token));
}

/**
 * Load and validate a workflow run operation token.
 */
export function loadWorkflowRunOperationToken(data: string): WorkflowRunOperationToken {
  if (!data) {
    throw new TypeError('invalid workflow run token: token is empty');
  }
  let decoded: string;
  try {
    decoded = base64URLDecodeNoPadding(data);
  } catch (err) {
    throw new TypeError('failed to decode token', { cause: err });
  }
  let token: WorkflowRunOperationToken;
  try {
    token = JSON.parse(decoded);
  } catch (err) {
    throw new TypeError('failed to unmarshal workflow run operation token', { cause: err });
  }
  if (token.t !== OPERATION_TOKEN_TYPE_WORKFLOW_RUN) {
    throw new TypeError(`invalid workflow token type: ${token.t}, expected: ${OPERATION_TOKEN_TYPE_WORKFLOW_RUN}`);
  }
  if (token.v !== undefined && token.v !== 0) {
    throw new TypeError('invalid workflow run token: "v" field should not be present');
  }
  if (!token.wid) {
    throw new TypeError('invalid workflow run token: missing workflow ID (wid)');
  }
  return token;
}

// Exported for use in tests.
export function base64URLEncodeNoPadding(str: string): string {
  const base64 = Buffer.from(str).toString('base64url');
  return base64.replace(/=+$/, '');
}

function base64URLDecodeNoPadding(str: string): string {
  // Validate the string contains only valid base64URL characters
  if (!/^[-A-Za-z0-9_]*$/.test(str)) {
    throw new TypeError('invalid base64URL encoded string: contains invalid characters');
  }

  const paddingLength = str.length % 4;
  if (paddingLength > 0) {
    str += '='.repeat(4 - paddingLength);
  }

  return Buffer.from(str, 'base64url').toString('utf-8');
}
