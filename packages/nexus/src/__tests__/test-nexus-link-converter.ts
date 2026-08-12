import test from 'ava';
import Long from 'long';
import { temporal } from '@temporalio/proto';
import {
  convertActivityLinkToNexusLink,
  convertNexusLinkToTemporalLink,
  convertNexusLinkToWorkflowEventLink,
  convertNexusLinkToWorkflowLink,
  convertNexusOperationLinkToNexusLink,
  convertTemporalLinkToNexusLink,
  convertWorkflowEventLinkToNexusLink,
  convertWorkflowLinkToNexusLink,
} from '../link-converter';

const { EventType } = temporal.api.enums.v1;
const WORKFLOW_EVENT_TYPE = (temporal.api.common.v1.Link.WorkflowEvent as any).fullName.slice(1);
const NEXUS_OPERATION_TYPE = (temporal.api.common.v1.Link.NexusOperation as any).fullName.slice(1);
const WORKFLOW_TYPE = (temporal.api.common.v1.Link.Workflow as any).fullName.slice(1);
const ACTIVITY_TYPE = (temporal.api.common.v1.Link.Activity as any).fullName.slice(1);

function makeEventRef(eventId: number, eventType: keyof typeof EventType) {
  return {
    eventId: Long.fromNumber(eventId),
    eventType: EventType[eventType],
  };
}

function makeRequestIdRef(requestId: string, eventType: keyof typeof EventType) {
  return {
    requestId,
    eventType: EventType[eventType],
  };
}

test('convertWorkflowEventLinkToNexusLink and back with eventRef', (t) => {
  const we = {
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
    eventRef: makeEventRef(42, 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED'),
  };
  const nexusLink = convertWorkflowEventLinkToNexusLink(we);
  t.is(nexusLink.type, WORKFLOW_EVENT_TYPE);
  t.regex(nexusLink.url.toString(), /^temporal:\/\/\/namespaces\/ns\/workflows\/wid\/rid\/history\?/);

  const roundTrip = convertNexusLinkToWorkflowEventLink(nexusLink);
  t.deepEqual(roundTrip, we);
});

test('convertWorkflowEventLinkToNexusLink and back with requestIdRef', (t) => {
  const we = {
    namespace: 'ns2',
    workflowId: 'wid2',
    runId: 'rid2',
    requestIdRef: makeRequestIdRef('req-123', 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED'),
  };
  const nexusLink = convertWorkflowEventLinkToNexusLink(we);
  t.is(nexusLink.type, WORKFLOW_EVENT_TYPE);
  t.regex(nexusLink.url.toString(), /^temporal:\/\/\/namespaces\/ns2\/workflows\/wid2\/rid2\/history\?/);

  const roundTrip = convertNexusLinkToWorkflowEventLink(nexusLink);
  t.deepEqual(roundTrip, we);
});

test('convertNexusLinkToLinkWorkflowEvent with an event type in PascalCase', (t) => {
  const nexusLink = {
    url: new URL(
      'temporal:///namespaces/ns2/workflows/wid2/rid2/history?referenceType=RequestIdReference&requestID=req-123&eventType=WorkflowTaskCompleted'
    ),
    type: WORKFLOW_EVENT_TYPE,
  };

  const workflowEventLink = convertNexusLinkToWorkflowEventLink(nexusLink);
  t.is(workflowEventLink.requestIdRef?.eventType, EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED);
});

test('convertNexusOperationLinkToNexusLink and back with runId', (t) => {
  const opLink = {
    namespace: 'ns',
    operationId: 'op-123',
    runId: 'run-456',
  };

  const nexusLink = convertNexusOperationLinkToNexusLink(opLink);
  t.is(nexusLink.type, NEXUS_OPERATION_TYPE);
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/ns/nexus-operations/op-123/run-456/details');

  const roundTrip = convertNexusLinkToTemporalLink(nexusLink);
  t.deepEqual(roundTrip, { nexusOperation: opLink });
});

test('convertNexusOperationLinkToNexusLink escapes URL path components', (t) => {
  const opLink = {
    namespace: 'name/space',
    operationId: 'operation id',
    runId: 'run/id',
  };

  const nexusLink = convertNexusOperationLinkToNexusLink(opLink);
  t.is(
    nexusLink.url.toString(),
    'temporal:///namespaces/name%2Fspace/nexus-operations/operation%20id/run%2Fid/details'
  );

  const roundTrip = convertNexusLinkToTemporalLink(nexusLink);
  t.deepEqual(roundTrip, {
    nexusOperation: {
      namespace: 'name/space',
      operationId: 'operation id',
      runId: 'run/id',
    },
  });
});

test('convertActivityLinkToNexusLink and back', (t) => {
  const activity = {
    namespace: 'ns',
    activityId: 'activity-123',
    runId: 'run-456',
  };

  const nexusLink = convertActivityLinkToNexusLink(activity);
  t.is(nexusLink.type, ACTIVITY_TYPE);
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/ns/activities/activity-123/run-456/details');

  const roundTrip = convertNexusLinkToTemporalLink(nexusLink);
  t.deepEqual(roundTrip, { activity });
});

test('convertActivityLinkToNexusLink escapes URL path components', (t) => {
  const activity = {
    namespace: 'name/space',
    activityId: 'activity/id',
    runId: 'run>id',
  };

  const nexusLink = convertActivityLinkToNexusLink(activity);
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/name%2Fspace/activities/activity%2Fid/run%3Eid/details');

  const roundTrip = convertNexusLinkToTemporalLink(nexusLink);
  t.deepEqual(roundTrip, { activity });
});

test('convertWorkflowLinkToNexusLink produces a workflow URL with the Workflow link type', (t) => {
  // A Workflow link addresses the execution itself, so there is no '/history' suffix. That suffix
  // belongs to the workflow event form, and its absence is what distinguishes the two paths.
  const nexusLink = convertWorkflowLinkToNexusLink({
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
  });
  t.is(nexusLink.type, WORKFLOW_TYPE);
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/ns/workflows/wid/rid');
});

test('convertWorkflowLinkToNexusLink carries reason as a query param', (t) => {
  const nexusLink = convertWorkflowLinkToNexusLink({
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
    reason: 'rejected update',
  });
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/ns/workflows/wid/rid?reason=rejected+update');
});

test('convertWorkflowLinkToNexusLink escapes URL path components', (t) => {
  const nexusLink = convertWorkflowLinkToNexusLink({
    namespace: 'name/space',
    workflowId: 'work id',
    runId: 'run/id',
  });
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/name%2Fspace/workflows/work%20id/run%2Fid');
});

test('convertWorkflowLinkToNexusLink throws on missing required fields', (t) => {
  t.throws(() => convertWorkflowLinkToNexusLink({ namespace: '', workflowId: 'wid', runId: 'rid' }), {
    instanceOf: TypeError,
  });
  t.throws(() => convertWorkflowLinkToNexusLink({ namespace: 'ns', workflowId: '', runId: 'rid' }), {
    instanceOf: TypeError,
  });
  // An empty run ID would address no particular run, so the converter rejects it and lets the
  // caller drop the link rather than attach one that resolves nowhere useful.
  t.throws(() => convertWorkflowLinkToNexusLink({ namespace: 'ns', workflowId: 'wid', runId: '' }), {
    instanceOf: TypeError,
  });
});

test('convertTemporalLinkToNexusLink dispatches by Temporal link variant', (t) => {
  const workflowEvent = {
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
    eventRef: makeEventRef(42, 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED'),
  };
  const nexusOperation = {
    namespace: 'ns',
    operationId: 'op-123',
    runId: 'run-456',
  };
  const workflow = { namespace: 'ns', workflowId: 'wid', runId: 'rid' };
  const activity = { namespace: 'ns', activityId: 'activity-123', runId: 'run-456' };

  t.is(convertTemporalLinkToNexusLink({ workflowEvent }).type, WORKFLOW_EVENT_TYPE);
  t.is(convertTemporalLinkToNexusLink({ nexusOperation }).type, NEXUS_OPERATION_TYPE);
  t.is(convertTemporalLinkToNexusLink({ workflow }).type, WORKFLOW_TYPE);
  t.is(convertTemporalLinkToNexusLink({ activity }).type, ACTIVITY_TYPE);

  // workflowEvent wins when the server populates more than one variant.
  t.is(convertTemporalLinkToNexusLink({ workflowEvent, workflow }).type, WORKFLOW_EVENT_TYPE);
});

test('convertNexusLinkToTemporalLink dispatches by Nexus link type', (t) => {
  const workflowEvent = {
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
    eventRef: makeEventRef(42, 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED'),
  };
  const nexusOperation = {
    namespace: 'ns',
    operationId: 'op-123',
    runId: 'run-456',
  };
  const activity = { namespace: 'ns', activityId: 'activity-123', runId: 'run-456' };

  t.deepEqual(convertNexusLinkToTemporalLink(convertWorkflowEventLinkToNexusLink(workflowEvent)), { workflowEvent });
  t.deepEqual(convertNexusLinkToTemporalLink(convertNexusOperationLinkToNexusLink(nexusOperation)), { nexusOperation });
  t.deepEqual(convertNexusLinkToTemporalLink(convertActivityLinkToNexusLink(activity)), { activity });
});

test('throws on missing required fields', (t) => {
  t.throws(
    () =>
      convertWorkflowEventLinkToNexusLink({
        namespace: '',
        workflowId: 'wid',
        runId: 'rid',
      }),
    { instanceOf: TypeError }
  );
  t.throws(
    () =>
      convertWorkflowEventLinkToNexusLink({
        namespace: 'ns',
        workflowId: '',
        runId: 'rid',
      }),
    { instanceOf: TypeError }
  );
  t.throws(
    () =>
      convertWorkflowEventLinkToNexusLink({
        namespace: 'ns',
        workflowId: 'wid',
        runId: '',
      }),
    { instanceOf: TypeError }
  );
  t.throws(
    () =>
      convertNexusOperationLinkToNexusLink({
        namespace: '',
        operationId: 'op-123',
      }),
    { instanceOf: TypeError }
  );
  t.throws(
    () =>
      convertNexusOperationLinkToNexusLink({
        namespace: 'ns',
        operationId: '',
      }),
    { instanceOf: TypeError }
  );
  t.throws(
    () =>
      convertNexusOperationLinkToNexusLink({
        namespace: 'ns',
        operationId: 'op-123',
        runId: '',
      }),
    { instanceOf: TypeError }
  );
  t.throws(() => convertActivityLinkToNexusLink({ namespace: '', activityId: 'activity-123', runId: 'run-456' }), {
    instanceOf: TypeError,
  });
  t.throws(() => convertActivityLinkToNexusLink({ namespace: 'ns', activityId: '', runId: 'run-456' }), {
    instanceOf: TypeError,
  });
  t.throws(() => convertActivityLinkToNexusLink({ namespace: 'ns', activityId: 'activity-123', runId: '' }), {
    instanceOf: TypeError,
  });
});

test('throws on invalid URL scheme', (t) => {
  const fakeLink = {
    url: new URL('http://example.com'),
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink), { instanceOf: TypeError });
  t.throws(() => convertNexusLinkToTemporalLink(fakeLink), { instanceOf: TypeError });
});

test('throws on invalid URL path', (t) => {
  const fakeLink = {
    url: new URL('temporal:///badpath'),
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink), { instanceOf: TypeError });
});

test('throws on invalid nexus operation URL path', (t) => {
  const fakeLink = {
    url: new URL('temporal:///namespaces/ns/workflows/wid/rid/history'),
    type: NEXUS_OPERATION_TYPE,
  };
  t.throws(() => convertNexusLinkToTemporalLink(fakeLink), { instanceOf: TypeError });
});

test('throws on invalid activity URL path', (t) => {
  const malformedLink = {
    url: new URL('temporal:///namespaces/ns/activities/activity-123/run-456'),
    type: ACTIVITY_TYPE,
  };
  t.throws(() => convertNexusLinkToTemporalLink(malformedLink), { instanceOf: TypeError });

  const incompleteLink = {
    url: new URL('temporal:///namespaces/ns/activities/activity-123//details'),
    type: ACTIVITY_TYPE,
  };
  t.throws(() => convertNexusLinkToTemporalLink(incompleteLink), { instanceOf: TypeError });
});

test('throws on invalid Temporal link variant', (t) => {
  t.throws(() => convertTemporalLinkToNexusLink({}), { instanceOf: TypeError });
});

test('throws on unknown Nexus link type', (t) => {
  const fakeLink = {
    url: new URL('temporal:///namespaces/ns/nexus-operations/op-123'),
    type: 'temporal.api.common.v1.Link.Unknown',
  };
  t.throws(() => convertNexusLinkToTemporalLink(fakeLink), { instanceOf: TypeError });
});

test('throws on unknown reference type', (t) => {
  const url = new URL('temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=UnknownType');
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink), { instanceOf: TypeError });
});

test('throws on missing eventType in eventRef', (t) => {
  const url = new URL('temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=EventReference&eventID=1');
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink), { message: /Missing eventType parameter/ });
});

test('throws on unknown eventType in eventRef', (t) => {
  const url = new URL(
    'temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=EventReference&eventID=1&eventType=NotAType'
  );
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink), { message: /Unknown eventType parameter/ });
});

test('throws on missing eventType in requestIdRef', (t) => {
  const url = new URL(
    'temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=RequestIdReference&requestID=req'
  );
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink), { message: /Missing eventType parameter/ });
});

test('throws on unknown eventType in requestIdRef', (t) => {
  const url = new URL(
    'temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=RequestIdReference&requestID=req&eventType=NotAType'
  );
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink), { message: /Unknown eventType parameter/ });
});

test('convertNexusLinkToWorkflowLink parses a workflow URL', (t) => {
  const workflowLink = convertNexusLinkToWorkflowLink({
    url: new URL('temporal:///namespaces/ns/workflows/wid/rid'),
    type: WORKFLOW_TYPE,
  });
  t.deepEqual(workflowLink, { namespace: 'ns', workflowId: 'wid', runId: 'rid' });
});

test('convertNexusLinkToWorkflowLink parses reason', (t) => {
  const workflowLink = convertNexusLinkToWorkflowLink({
    url: new URL('temporal:///namespaces/ns/workflows/wid/rid?reason=rejected+update'),
    type: WORKFLOW_TYPE,
  });
  t.is(workflowLink.reason, 'rejected update');
});

test('convertNexusLinkToWorkflowLink finds reason by key, not position', (t) => {
  const workflowLink = convertNexusLinkToWorkflowLink({
    url: new URL('temporal:///namespaces/ns/workflows/wid/rid?foo=bar&reason=Query+processed'),
    type: WORKFLOW_TYPE,
  });
  t.is(workflowLink.reason, 'Query processed');
});

test('convertNexusLinkToWorkflowLink leaves reason unset when absent', (t) => {
  // A key that merely starts with 'reason' must not be treated as 'reason'.
  const workflowLink = convertNexusLinkToWorkflowLink({
    url: new URL('temporal:///namespaces/ns/workflows/wid/rid?reasonx=nope'),
    type: WORKFLOW_TYPE,
  });
  t.is(workflowLink.reason, undefined);
});

test('convertNexusLinkToWorkflowLink rejects a trailing path segment', (t) => {
  // The workflow event form addresses an event inside the Workflow, so it must not be accepted as a
  // Workflow link even when the type says otherwise.
  t.throws(
    () =>
      convertNexusLinkToWorkflowLink({
        url: new URL('temporal:///namespaces/ns/workflows/wid/rid/history'),
        type: WORKFLOW_TYPE,
      }),
    { instanceOf: TypeError }
  );
});

test('convertNexusLinkToWorkflowLink rejects a missing run ID', (t) => {
  t.throws(
    () =>
      convertNexusLinkToWorkflowLink({
        url: new URL('temporal:///namespaces/ns/workflows/wid'),
        type: WORKFLOW_TYPE,
      }),
    { instanceOf: TypeError }
  );
});

test('convertNexusLinkToWorkflowEventLink rejects a suffixless workflow path', (t) => {
  // The inverse of the trailing-segment case: a Workflow link must not be readable as a workflow
  // event.
  t.throws(
    () =>
      convertNexusLinkToWorkflowEventLink({
        url: new URL('temporal:///namespaces/ns/workflows/wid/rid'),
        type: WORKFLOW_EVENT_TYPE,
      }),
    { instanceOf: TypeError }
  );
});

test('convertNexusLinkToTemporalLink dispatches the Workflow link type', (t) => {
  const temporalLink = convertNexusLinkToTemporalLink({
    url: new URL('temporal:///namespaces/ns/workflows/wid/rid?reason=Query+processed'),
    type: WORKFLOW_TYPE,
  });
  t.deepEqual(temporalLink, {
    workflow: { namespace: 'ns', workflowId: 'wid', runId: 'rid', reason: 'Query processed' },
  });
});

test('Workflow link round trips through both converters', (t) => {
  // Reserved characters in every field at once: path segments are percent escaped and the reason is a
  // query value, so a reason containing '=' and '&' must not be split as query syntax.
  const workflowLink = {
    namespace: 'ns/with/slash',
    workflowId: 'wf id with space',
    runId: 'rid',
    reason: 'reason with = and &',
  };
  t.deepEqual(convertNexusLinkToWorkflowLink(convertWorkflowLinkToNexusLink(workflowLink)), workflowLink);
});

test('Workflow link reason round trips a literal plus', (t) => {
  // URLSearchParams form encodes, writing a space as '+' and a literal '+' as '%2B', and its reader
  // reverses that. Percent decoding alone would turn this reason into 'a b'.
  const nexusLink = convertWorkflowLinkToNexusLink({
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
    reason: 'a+b',
  });
  t.is(nexusLink.url.search, '?reason=a%2Bb');
  t.is(convertNexusLinkToWorkflowLink(nexusLink).reason, 'a+b');
});
