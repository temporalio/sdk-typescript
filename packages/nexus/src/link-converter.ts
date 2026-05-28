import Long from 'long';
import type { Link as NexusLink } from 'nexus-rpc';
import { temporal } from '@temporalio/proto';

const { EventType } = temporal.api.enums.v1;
type TemporalLink = temporal.api.common.v1.ILink;
type WorkflowEventLink = temporal.api.common.v1.Link.IWorkflowEvent;
type NexusOperationLink = temporal.api.common.v1.Link.INexusOperation;
type EventReference = temporal.api.common.v1.Link.WorkflowEvent.IEventReference;
type RequestIdReference = temporal.api.common.v1.Link.WorkflowEvent.IRequestIdReference;

const LINK_EVENT_ID_PARAM = 'eventID';
const LINK_EVENT_TYPE_PARAM = 'eventType';
const LINK_REQUEST_ID_PARAM = 'requestID';
const LINK_REFERENCE_TYPE_KEY = 'referenceType';
const LINK_RUN_ID_KEY = 'runID';

const EVENT_REFERENCE_TYPE = 'EventReference';
const REQUEST_ID_REFERENCE_TYPE = 'RequestIdReference';

// fullName isn't part of the generated typed unfortunately.
const WORKFLOW_EVENT_TYPE: string = (temporal.api.common.v1.Link.WorkflowEvent as any).fullName.slice(1);
const NEXUS_OPERATION_TYPE: string = (temporal.api.common.v1.Link.NexusOperation as any).fullName.slice(1);

export function convertTemporalLinkToNexusLink(link: TemporalLink): NexusLink {
  if (link.workflowEvent != null) {
    return convertWorkflowEventLinkToNexusLink(link.workflowEvent);
  }

  if (link.nexusOperation != null) {
    return convertNexusOperationLinkToNexusLink(link.nexusOperation);
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

export function convertNexusOperationLinkToNexusLink(opLink: NexusOperationLink): NexusLink {
  if (!opLink.namespace || !opLink.operationId) {
    throw new TypeError('Missing required fields: namespace, or operationId');
  }

  const url = new URL(
    `temporal:///namespaces/${encodeURIComponent(opLink.namespace)}/nexus-operations/${encodeURIComponent(
      opLink.operationId
    )}`
  );

  if (opLink.runId != null) {
    const searchParams = new URLSearchParams();
    searchParams.set(LINK_RUN_ID_KEY, opLink.runId);
    url.search = searchParams.toString();
  }

  return {
    url,
    type: NEXUS_OPERATION_TYPE,
  };
}

export function convertNexusLinkToWorkflowEventLink(link: NexusLink): WorkflowEventLink {
  // /namespaces/:namespace/workflows/:workflowId/:runId/history
  const parts = link.url.pathname.split('/');
  if (parts.length !== 7 || parts[1] !== 'namespaces' || parts[3] !== 'workflows' || parts[6] !== 'history') {
    throw new TypeError(`Invalid URL path: ${link.url}`);
  }
  const namespace = decodeURIComponent(parts[2]!);
  const workflowId = decodeURIComponent(parts[4]!);
  const runId = decodeURIComponent(parts[5]!);

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
  // /namespaces/:namespace/nexus-operations/:operationId?runId=:runId
  const parts = link.url.pathname.split('/');
  if (parts.length !== 5 || parts[1] !== 'namespaces' || parts[3] !== 'nexus-operations') {
    throw new TypeError(`Invalid URL path: ${link.url}`);
  }
  const namespace = decodeURIComponent(parts[2]!);
  const operationId = decodeURIComponent(parts[4]!);

  const query = link.url.searchParams;
  const runId = query.get(LINK_RUN_ID_KEY);

  return {
    namespace,
    operationId,
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
