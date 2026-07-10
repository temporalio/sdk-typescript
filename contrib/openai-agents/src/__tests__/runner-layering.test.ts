import test from 'ava';
import { layerModelParams } from '../workflow/runner';
import { DEFAULT_MODEL_ACTIVITY_OPTIONS, type ModelSummaryProvider } from '../common/model-activity-options';

test('layerModelParams: header only — per-client fields win over DEFAULT', (t) => {
  const merged = layerModelParams(undefined, { startToCloseTimeout: '99s', useLocalActivity: true });
  t.is(merged.startToCloseTimeout, '99s');
  t.is(merged.useLocalActivity, true);
});

test('layerModelParams: neither header nor constructor — returns DEFAULT', (t) => {
  const merged = layerModelParams(undefined, undefined);
  t.is(merged.startToCloseTimeout, DEFAULT_MODEL_ACTIVITY_OPTIONS.startToCloseTimeout);
  t.is(merged.useLocalActivity, DEFAULT_MODEL_ACTIVITY_OPTIONS.useLocalActivity);
});

test('layerModelParams: constructor only, no header — header-less Workflow gets defaultModelParams', (t) => {
  // A Schedule/UI/CLI-started Workflow has no config header, so the constructor
  // default is the only source layered above DEFAULT.
  const merged = layerModelParams({ startToCloseTimeout: '120s', streamingTopic: 'events' }, undefined);
  t.is(merged.startToCloseTimeout, '120s');
  t.is(merged.streamingTopic, 'events');
  t.is(merged.useLocalActivity, false);
});

test('layerModelParams: both present — client overrides matching field, non-overlapping constructor fields survive', (t) => {
  // Merge-trap regression: the header layer must carry ONLY client-set fields. If
  // DEFAULT were pre-baked into it, DEFAULT's startToCloseTimeout/useLocalActivity
  // would clobber the constructor's even though the client never set them.
  const merged = layerModelParams(
    { startToCloseTimeout: '120s', useLocalActivity: true, streamingTopic: 'events' },
    { startToCloseTimeout: '30s' }
  );
  t.is(merged.startToCloseTimeout, '30s');
  t.is(merged.streamingTopic, 'events');
  t.is(merged.useLocalActivity, true);
});

test('layerModelParams: streamingTopic supplied only via defaultModelParams', (t) => {
  const merged = layerModelParams({ streamingTopic: 'events' }, { startToCloseTimeout: '30s' });
  t.is(merged.streamingTopic, 'events');
});

test('layerModelParams: an explicit undefined field never clobbers a lower layer', (t) => {
  const merged = layerModelParams({ streamingTopic: 'events' }, {
    streamingTopic: undefined,
    startToCloseTimeout: '30s',
  } as any);
  t.is(merged.streamingTopic, 'events');
});

test('layerModelParams: a defined falsy field in the header overrides a truthy lower layer', (t) => {
  // Guards definedFields against a truthiness check: `false` is defined and must
  // win over the constructor's `true`, not be dropped as if it were unset.
  const merged = layerModelParams({ useLocalActivity: true }, { useLocalActivity: false });
  t.is(merged.useLocalActivity, false);
});

test('layerModelParams: a defined 0 in the header overrides a lower layer', (t) => {
  const merged = layerModelParams({ streamingBatchInterval: 100 }, { streamingBatchInterval: 0 });
  t.is(merged.streamingBatchInterval, 0);
});

test('layerModelParams: function-form summary from defaultModelParams passes through', (t) => {
  const provider: ModelSummaryProvider = { provide: () => 'dynamic' };
  const merged = layerModelParams({ summary: provider }, undefined);
  t.is(merged.summary, provider);
});
