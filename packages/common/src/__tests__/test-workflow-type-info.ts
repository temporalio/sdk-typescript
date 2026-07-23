import test from 'ava';
import type { PayloadTypeInfo } from '../type-info';
import { extractWorkflowType, extractWorkflowTypeAndConfig } from '../workflow-options';

const typeInfo: PayloadTypeInfo = {
  inputTypes: [{ hint: { converter: 'json' } }],
  outputType: { hint: { converter: 'json' } },
};

test('resolves call-site type information for a string Workflow type', (t) => {
  t.deepEqual(extractWorkflowTypeAndConfig('workflow', typeInfo), {
    type: 'workflow',
    typeInfo,
  });
});

test('resolves definition-supplied type information for a Workflow function', (t) => {
  const workflow = Object.assign(async function workflow(): Promise<void> {}, {
    staticOptions: { typeInfo },
  });

  t.deepEqual(extractWorkflowTypeAndConfig(workflow), {
    type: 'workflow',
    typeInfo,
  });
  t.is(extractWorkflowType(workflow), 'workflow');
});

test('rejects call-site type information for a Workflow function', (t) => {
  async function workflow(): Promise<void> {}

  t.throws(() => extractWorkflowTypeAndConfig(workflow, typeInfo), {
    instanceOf: TypeError,
    message: /Workflow type information cannot be supplied at the call site/,
  });
});

test('ignores explicitly undefined static options', (t) => {
  const workflow = Object.assign(async function workflow(): Promise<void> {}, {
    staticOptions: undefined,
  });

  t.deepEqual(extractWorkflowTypeAndConfig(workflow), {
    type: 'workflow',
    typeInfo: undefined,
  });
});
