import Long from 'long';
import type { Link as NexusLink } from 'nexus-rpc';
import { temporal } from '@temporalio/proto';

const { EventType } = temporal.api.enums.v1;
type TemporalLink = temporal.api.common.v1.ILink;
type WorkflowEventLink = temporal.api.common.v1.Link.IWorkflowEvent;
type WorkflowLink = temporal.api.common.v1.Link.IWorkflow;
type NexusOperationLink = temporal.api.common.v1.Link.INexusOperation;
type ActivityLink = temporal.api.common.v1.Link.IActivity;
type EventReference = temporal.api.common.v1.Link.WorkflowEvent.IEventReference;
type RequestIdReference = temporal.api.common.v1.Link.WorkflowEvent.IRequestIdReference;

const LINK_EVENT_ID_PARAM = 'eventID';
const LINK_EVENT_TYPE_PARAM = 'eventType';
const LINK_REQUEST_ID_PARAM = 'requestID';
const LINK_REFERENCE_TYPE_KEY = 'referenceType';
const LINK_REASON_PARAM = 'reason';

const EVENT_REFERENCE_TYPE = 'EventReference';
const REQUEST_ID_REFERENCE_TYPE = 'RequestIdReference';

// fullName isn't part of the generated typed unfortunately.
const WORKFLOW_EVENT_TYPE: string = (temporal.api.common.v1.Link.WorkflowEvent as any).fullName.slice(1);
const NEXUS_OPERATION_TYPE: string = (temporal.api.common.v1.Link.NexusOperation as any).fullName.slice(1);
const WORKFLOW_TYPE: string = (temporal.api.common.v1.Link.Workflow as any).fullName.slice(1);
const ACTIVITY_TYPE: string = (temporal.api.common.v1.Link.Activity as any).fullName.slice(1);

export function convertTemporalLinkToNexusLink(link: TemporalLink): NexusLink {
  if (link.workflowEvent != null) {
    return convertWorkflowEventLinkToNexusLink(link.workflowEvent);
  }

  if (link.nexusOperation != null) {
    return convertNexusOperationLinkToNexusLink(link.nexusOperation);
  }

  if (link.workflow != null) {
    return convertWorkflowLinkToNexusLink(link.workflow);
  }

  if (link.activity != null) {
    return convertActivityLinkToNexusLink(link.activity);
  }

  throw new TypeError('Invalid Temporal link: unknown variant');
}

export function convertNexusLinkToTemporalLink(link: NexusLink): TemporalLink {
  if (link.url.protocol !== 'temporal:') {
    throw new TypeError(`Invalid URL scheme: ${link.url}, expected 'temporal:', got '${link.url.protocol}'`);
  }
  switch (link.type) {
    case WORKFLOW_EVENT_TYPE:
      return {
        workflowEvent: convertNexusLinkToWorkflowEventLink(link),
      };

    case NEXUS_OPERATION_TYPE:
      return {
        nexusOperation: convertNexusLinkToNexusOperationLink(link),
      };

    case WORKFLOW_TYPE:
      return {
        workflow: convertNexusLinkToWorkflowLink(link),
      };

    case ACTIVITY_TYPE:
      return {
        activity: convertNexusLinkToActivityLink(link),
      };

    default:
      throw new TypeError(`Unknown link type: ${link.type}`);
  }
}

export function convertWorkflowEventLinkToNexusLink(we: WorkflowEventLink): NexusLink {
  if (!we.namespace || !we.workflowId || !we.runId) {
    throw new TypeError('Missing required fields: namespace, workflowId, or runId');
  }
  const url = new URL(
    `temporal:///namespaces/${encodeURIComponent(we.namespace)}/workflows/${encodeURIComponent(
      we.workflowId
    )}/${encodeURIComponent(we.runId)}/history`
  );

  if (we.eventRef != null) {
    url.search = convertLinkWorkflowEventEventReferenceToURLQuery(we.eventRef);
  } else if (we.requestIdRef != null) {
    url.search = convertLinkWorkflowEventRequestIdReferenceToURLQuery(we.requestIdRef);
  }

  return {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
}

/**
 * Converts a plain Workflow link (as opposed to a {@link WorkflowEventLink}) to a Nexus link.
 *
 * A Workflow link addresses a Workflow execution as a whole rather than one event within it, so the
 * URL carries no event path suffix and no reference query params. It is used when there is no history
 * event to point at, e.g. a Query, or an UpdateWorkflow-backed Nexus operation that fails validation
 * and so has no Update Accepted event. The absence of the `/history` suffix is what distinguishes
 * this path from a workflow event link's.
 *
 * The optional `reason` explaining why the link exists is carried as a query param.
 *
 * `runId` is required: the server populates the resolved run ID even on the plain Workflow link it
 * returns, so a missing one is unexpected; throwing (rather than coalescing to '') lets callers drop
 * the link instead of attaching one that addresses no particular run.
 */
export function convertWorkflowLinkToNexusLink(wl: WorkflowLink): NexusLink {
  if (!wl.namespace || !wl.workflowId || !wl.runId) {
    throw new TypeError(
      `Missing required fields: namespace, workflowId, or runId (namespace=${wl.namespace}, workflowId=${wl.workflowId}, runId=${wl.runId})`
    );
  }
  const url = new URL(
    `temporal:///namespaces/${encodeURIComponent(wl.namespace)}/workflows/${encodeURIComponent(
      wl.workflowId
    )}/${encodeURIComponent(wl.runId)}`
  );

  if (wl.reason) {
    const params = new URLSearchParams();
    params.set(LINK_REASON_PARAM, wl.reason);
    url.search = params.toString();
  }

  return {
    url,
    type: WORKFLOW_TYPE,
  };
}

/**
 * Converts a Nexus link back to a plain Workflow link.
 *
 * The run ID ends a Workflow link, so anything trailing is rejected. In particular this rejects the
 * workflow event form, which ends in `history` and is otherwise identical.
 */
export function convertNexusLinkToWorkflowLink(link: NexusLink): WorkflowLink {
  // /namespaces/:namespace/workflows/:workflowId/:runId
  const [namespace, workflowId, runId] = parseTemporalLinkPath(link, 'workflows');

  if (!namespace || !workflowId || !runId) {
    throw new TypeError('Missing required fields: namespace, workflowId, or runId');
  }

  const workflowLink: WorkflowLink = { namespace, workflowId, runId };
  const reason = link.url.searchParams.get(LINK_REASON_PARAM);
  if (reason != null) {
    workflowLink.reason = reason;
  }
  return workflowLink;
}

/**
 * Validates a Temporal link path of the shape `/namespaces/:namespace/:collection/:id/:runId[/:tail]`
 * and returns its three decoded variable segments.
 *
 * Passing no `tail` means nothing may follow the run ID, which is what separates a plain Workflow
 * link from a workflow event link since both live under `workflows`.
 */
function parseTemporalLinkPath(link: NexusLink, collection: string, tail?: string): [string, string, string] {
  const parts = link.url.pathname.split('/');
  const expectedLength = tail == null ? 6 : 7;
  if (
    parts.length !== expectedLength ||
    parts[1] !== 'namespaces' ||
    parts[3] !== collection ||
    (tail != null && parts[6] !== tail)
  ) {
    throw new TypeError(`Invalid URL path: ${link.url}`);
  }
  return [decodeURIComponent(parts[2]!), decodeURIComponent(parts[4]!), decodeURIComponent(parts[5]!)];
}

export function convertNexusOperationLinkToNexusLink(opLink: NexusOperationLink): NexusLink {
  if (!opLink.namespace || !opLink.operationId || !opLink.runId) {
    throw new TypeError('Missing required fields: namespace, operationId, or runId');
  }

  const url = new URL(
    `temporal:///namespaces/${encodeURIComponent(opLink.namespace)}/nexus-operations/${encodeURIComponent(
      opLink.operationId
    )}/${encodeURIComponent(opLink.runId)}/details`
  );

  return {
    url,
    type: NEXUS_OPERATION_TYPE,
  };
}

export function convertActivityLinkToNexusLink(activityLink: ActivityLink): NexusLink {
  if (!activityLink.namespace || !activityLink.activityId || !activityLink.runId) {
    throw new TypeError('Missing required fields: namespace, activityId, or runId');
  }

  const url = new URL(
    `temporal:///namespaces/${encodeURIComponent(activityLink.namespace)}/activities/${encodeURIComponent(
      activityLink.activityId
    )}/${encodeURIComponent(activityLink.runId)}/details`
  );

  return {
    url,
    type: ACTIVITY_TYPE,
  };
}

export function convertNexusLinkToWorkflowEventLink(link: NexusLink): WorkflowEventLink {
  // /namespaces/:namespace/workflows/:workflowId/:runId/history
  const [namespace, workflowId, runId] = parseTemporalLinkPath(link, 'workflows', 'history');

  const query = link.url.searchParams;
  const refType = query.get(LINK_REFERENCE_TYPE_KEY);

  const workflowEventLink: WorkflowEventLink = {
    namespace,
    workflowId,
    runId,
  };

  switch (refType) {
    case EVENT_REFERENCE_TYPE:
      workflowEventLink.eventRef = convertURLQueryToLinkWorkflowEventEventReference(query);
      break;
    case REQUEST_ID_REFERENCE_TYPE:
      workflowEventLink.requestIdRef = convertURLQueryToLinkWorkflowEventRequestIdReference(query);
      break;
    default:
      throw new TypeError(`Unknown reference type: ${refType}`);
  }
  return workflowEventLink;
}

function convertNexusLinkToNexusOperationLink(link: NexusLink): NexusOperationLink {
  // /namespaces/:namespace/nexus-operations/:operationId/:runId/details
  const [namespace, operationId, runId] = parseTemporalLinkPath(link, 'nexus-operations', 'details');

  if (!namespace || !operationId || !runId) {
    throw new TypeError('Missing required fields: namespace, operationId, or runId');
  }

  return {
    namespace,
    operationId,
    runId,
  };
}

function convertNexusLinkToActivityLink(link: NexusLink): ActivityLink {
  // /namespaces/:namespace/activities/:activityId/:runId/details
  const [namespace, activityId, runId] = parseTemporalLinkPath(link, 'activities', 'details');

  if (!namespace || !activityId || !runId) {
    throw new TypeError('Missing required fields: namespace, activityId, or runId');
  }

  return {
    namespace,
    activityId,
    runId,
  };
}

function convertLinkWorkflowEventEventReferenceToURLQuery(eventRef: EventReference): string {
  const params = new URLSearchParams();
  params.set(LINK_REFERENCE_TYPE_KEY, EVENT_REFERENCE_TYPE);
  if (eventRef.eventId != null) {
    const eventId = eventRef.eventId.toNumber();
    if (eventId > 0) {
      params.set(LINK_EVENT_ID_PARAM, `${eventId}`);
    }
  }
  if (eventRef.eventType != null) {
    const eventType = constantCaseToPascalCase(EventType[eventRef.eventType].replace('EVENT_TYPE_', ''));
    params.set(LINK_EVENT_TYPE_PARAM, eventType);
  }
  return params.toString();
}

function convertURLQueryToLinkWorkflowEventEventReference(query: URLSearchParams): EventReference {
  let eventId = 0;
  const eventIdParam = query.get(LINK_EVENT_ID_PARAM);
  if (eventIdParam && /^\d+$/.test(eventIdParam)) {
    eventId = parseInt(eventIdParam, 10);
  }
  const eventTypeParam = query.get(LINK_EVENT_TYPE_PARAM);
  if (!eventTypeParam) {
    throw new TypeError(`Missing eventType parameter`);
  }
  const eventType = EventType[normalizeEnumValue(eventTypeParam, 'EVENT_TYPE') as keyof typeof EventType];
  if (eventType == null) {
    throw new TypeError(`Unknown eventType parameter: ${eventTypeParam}`);
  }
  return { eventId: Long.fromNumber(eventId), eventType };
}

function convertLinkWorkflowEventRequestIdReferenceToURLQuery(requestIdRef: RequestIdReference): string {
  const params = new URLSearchParams();
  params.set(LINK_REFERENCE_TYPE_KEY, REQUEST_ID_REFERENCE_TYPE);
  if (requestIdRef.requestId != null) {
    params.set(LINK_REQUEST_ID_PARAM, requestIdRef.requestId);
  }
  if (requestIdRef.eventType != null) {
    const eventType = constantCaseToPascalCase(EventType[requestIdRef.eventType].replace('EVENT_TYPE_', ''));
    params.set(LINK_EVENT_TYPE_PARAM, eventType);
  }
  return params.toString();
}

function convertURLQueryToLinkWorkflowEventRequestIdReference(query: URLSearchParams): RequestIdReference {
  const requestId = query.get(LINK_REQUEST_ID_PARAM);
  const eventTypeParam = query.get(LINK_EVENT_TYPE_PARAM);
  if (!eventTypeParam) {
    throw new TypeError(`Missing eventType parameter`);
  }
  const eventType = EventType[normalizeEnumValue(eventTypeParam, 'EVENT_TYPE') as keyof typeof EventType];
  if (eventType == null) {
    throw new TypeError(`Unknown eventType parameter: ${eventTypeParam}`);
  }
  return { requestId, eventType };
}

function normalizeEnumValue(value: string, prefix: string) {
  value = pascalCaseToConstantCase(value);
  if (!value.startsWith(prefix)) {
    value = `${prefix}_${value}`;
  }
  return value;
}

function pascalCaseToConstantCase(s: string) {
  return s.replace(/[^\b][A-Z]/g, (m) => `${m[0]}_${m[1]}`).toUpperCase();
}

function constantCaseToPascalCase(s: string) {
  return s.replace(/[A-Z]+_?/g, (m) => `${m[0]}${m.slice(1).toLocaleLowerCase()}`.replace(/_/, ''));
}
