import test from 'ava';
import Long from 'long';
import { temporal } from '@temporalio/proto';
import {
  convertCommonLinkToNexusLink,
  convertNexusLinkToTemporalLink,
  convertNexusLinkToWorkflowEventLink,
  convertNexusOperationLinkToNexusLink,
  convertTemporalLinkToNexusLink,
  convertWorkflowEventLinkToNexusLink,
  convertWorkflowLinkToNexusLink,
} from '../link-converter';

const { EventType } = temporal.api.enums.v1;
const WORKFLOW_EVENT_TYPE = (temporal.api.common.v1.Link.WorkflowEvent as any).fullName.slice(1);
const NEXUS_OPERATION_TYPE = (temporal.api.common.v1.Link.NexusOperation as any).fullName.slice(1);
const WORKFLOW_TYPE = (temporal.api.common.v1.Link.Workflow as any).fullName.slice(1);

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

test('convertWorkflowLinkToNexusLink produces a history URL with the Workflow link type', (t) => {
  const nexusLink = convertWorkflowLinkToNexusLink({
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
  });
  t.is(nexusLink.type, WORKFLOW_TYPE);
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/ns/workflows/wid/rid/history');
});

test('convertWorkflowLinkToNexusLink escapes URL path components', (t) => {
  const nexusLink = convertWorkflowLinkToNexusLink({
    namespace: 'name/space',
    workflowId: 'work id',
    runId: 'run/id',
  });
  t.is(nexusLink.url.toString(), 'temporal:///namespaces/name%2Fspace/workflows/work%20id/run%2Fid/history');
});

test('convertWorkflowLinkToNexusLink throws on missing required fields', (t) => {
  t.throws(() => convertWorkflowLinkToNexusLink({ namespace: '', workflowId: 'wid', runId: 'rid' }), {
    instanceOf: TypeError,
  });
  t.throws(() => convertWorkflowLinkToNexusLink({ namespace: 'ns', workflowId: '', runId: 'rid' }), {
    instanceOf: TypeError,
  });
  // An empty run ID would produce `.../workflows/wid//history`, whose double slash does not resolve
  // to a valid UI page, so the converter rejects it rather than emit a malformed URL.
  t.throws(() => convertWorkflowLinkToNexusLink({ namespace: 'ns', workflowId: 'wid', runId: '' }), {
    instanceOf: TypeError,
  });
});

test('convertCommonLinkToNexusLink dispatches by variant, preferring workflowEvent', (t) => {
  const workflowEvent = {
    namespace: 'ns',
    workflowId: 'wid',
    runId: 'rid',
    eventRef: makeEventRef(42, 'EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED'),
  };
  t.is(convertCommonLinkToNexusLink({ workflowEvent }).type, WORKFLOW_EVENT_TYPE);

  const workflowLink = { namespace: 'ns', workflowId: 'wid', runId: 'rid' };
  t.is(convertCommonLinkToNexusLink({ workflow: workflowLink }).type, WORKFLOW_TYPE);
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

  t.is(convertTemporalLinkToNexusLink({ workflowEvent }).type, WORKFLOW_EVENT_TYPE);
  t.is(convertTemporalLinkToNexusLink({ nexusOperation }).type, NEXUS_OPERATION_TYPE);
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

  t.deepEqual(convertNexusLinkToTemporalLink(convertWorkflowEventLinkToNexusLink(workflowEvent)), { workflowEvent });
  t.deepEqual(convertNexusLinkToTemporalLink(convertNexusOperationLinkToNexusLink(nexusOperation)), { nexusOperation });
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
