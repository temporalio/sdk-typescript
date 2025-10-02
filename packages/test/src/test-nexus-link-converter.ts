import test from 'ava';
import Long from 'long';
import { temporal } from '@temporalio/proto';
import {
  convertWorkflowEventLinkToNexusLink,
  convertNexusLinkToWorkflowEventLink,
} from '@temporalio/nexus/lib/link-converter';

const { EventType } = temporal.api.enums.v1;
const WORKFLOW_EVENT_TYPE = (temporal.api.common.v1.Link.WorkflowEvent as any).fullName.slice(1);

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
});

test('throws on invalid URL scheme', (t) => {
  const fakeLink = {
    url: new URL('http://example.com'),
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink as any), { instanceOf: TypeError });
});

test('throws on invalid URL path', (t) => {
  const fakeLink = {
    url: new URL('temporal:///badpath'),
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink as any), { instanceOf: TypeError });
});

test('throws on unknown reference type', (t) => {
  const url = new URL('temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=UnknownType');
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink as any), { instanceOf: TypeError });
});

test('throws on missing eventType in eventRef', (t) => {
  const url = new URL('temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=EventReference&eventID=1');
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink as any), { message: /Missing eventType parameter/ });
});

test('throws on unknown eventType in eventRef', (t) => {
  const url = new URL(
    'temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=EventReference&eventID=1&eventType=NotAType'
  );
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink as any), { message: /Unknown eventType parameter/ });
});

test('throws on missing eventType in requestIdRef', (t) => {
  const url = new URL(
    'temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=RequestIdReference&requestID=req'
  );
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink as any), { message: /Missing eventType parameter/ });
});

test('throws on unknown eventType in requestIdRef', (t) => {
  const url = new URL(
    'temporal:///namespaces/ns/workflows/wid/rid/history?referenceType=RequestIdReference&requestID=req&eventType=NotAType'
  );
  const fakeLink = {
    url,
    type: WORKFLOW_EVENT_TYPE,
  };
  t.throws(() => convertNexusLinkToWorkflowEventLink(fakeLink as any), { message: /Unknown eventType parameter/ });
});
