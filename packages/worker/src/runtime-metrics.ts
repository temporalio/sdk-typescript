import {
  IllegalStateError,
  Metric,
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  MetricMeter,
  MetricTags,
  NumericMetricValueType,
} from '@temporalio/common';
import { native } from '@temporalio/core-bridge';
import type { Runtime } from './runtime';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Metric Meter (aka Custom Metrics)
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * An implementation of the {@link MetricMeter} interface that pushes emitted metrics through
 * the bridge, to be collected by whatever exporter is configured on the Core Runtime.
 *
 * @internal
 */
export class RuntimeMetricMeter implements MetricMeter {
  public constructor(protected runtime: native.Runtime) {}

  createCounter(name: string, unit: string = '', description: string = ''): MetricCounter {
    const nativeMetric = native.newMetricCounter(this.runtime, name, unit, description);
    return new RuntimeMetricCounter(nativeMetric, name, unit, description);
  }

  createHistogram(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit: string = '',
    description: string = ''
  ): MetricHistogram {
    switch (valueType) {
      case 'int': {
        const nativeMetric = native.newMetricHistogram(this.runtime, name, unit, description);
        return new RuntimeMetricHistogram(nativeMetric, name, unit, description);
      }
      case 'float': {
        const nativeMetric = native.newMetricHistogramF64(this.runtime, name, unit, description);
        return new RuntimeMetricHistogramF64(nativeMetric, name, unit, description);
      }
    }
  }

  createGauge(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit: string = '',
    description: string = ''
  ): MetricGauge {
    switch (valueType) {
      case 'int': {
        const nativeMetric = native.newMetricGauge(this.runtime, name, unit, description);
        return new RuntimeMetricGauge(nativeMetric, name, unit, description);
      }
      case 'float': {
        const nativeMetric = native.newMetricGaugeF64(this.runtime, name, unit, description);
        return new RuntimeMetricGaugeF64(nativeMetric, name, unit, description);
      }
    }
  }

  withTags(_extraTags: MetricTags): MetricMeter {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error('withTags is not supported directly on RuntimeMetricMeter');
  }
}

class RuntimeMetricCounter implements MetricCounter {
  public readonly kind = 'counter';
  public readonly valueType = 'int';

  public constructor(
    private readonly native: native.MetricCounter,
    public readonly name: string,
    public readonly unit: string,
    public readonly description: string
  ) {}

  add(value: number, tags: MetricTags = {}): void {
    if (value < 0) {
      throw new Error(`MetricCounter value must be non-negative (got ${value})`);
    }
    native.addMetricCounterValue(this.native, value, JSON.stringify(tags));
  }

  withTags(_tags: MetricTags): MetricCounter {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error('withTags is not supported directly on RuntimeMetricCounter');
  }
}

class RuntimeMetricHistogram implements MetricHistogram {
  public readonly kind = 'histogram';
  public readonly valueType = 'int';

  public constructor(
    private readonly native: native.MetricHistogram,
    public readonly name: string,
    public readonly unit: string,
    public readonly description: string
  ) {}

  record(value: number, tags: MetricTags = {}): void {
    if (value < 0) {
      throw new Error(`MetricHistogram value must be non-negative (got ${value})`);
    }
    native.recordMetricHistogramValue(this.native, value, JSON.stringify(tags));
  }

  withTags(_tags: MetricTags): MetricHistogram {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error('withTags is not supported directly on RuntimeMetricHistogram');
  }
}

class RuntimeMetricHistogramF64 implements MetricHistogram {
  public readonly kind = 'histogram';
  public readonly valueType = 'float';

  public constructor(
    private readonly native: native.MetricHistogramF64,
    public readonly name: string,
    public readonly unit: string,
    public readonly description: string
  ) {}

  record(value: number, tags: MetricTags = {}): void {
    if (value < 0) {
      throw new Error(`MetricHistogram value must be non-negative (got ${value})`);
    }
    native.recordMetricHistogramF64Value(this.native, value, JSON.stringify(tags));
  }

  withTags(_tags: MetricTags): MetricHistogram {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error('withTags is not supported directly on RuntimeMetricHistogramF64');
  }
}

class RuntimeMetricGauge implements MetricGauge {
  public readonly kind = 'gauge';
  public readonly valueType = 'int';

  public constructor(
    private readonly native: native.MetricGauge,
    public readonly name: string,
    public readonly unit: string,
    public readonly description: string
  ) {}

  set(value: number, tags: MetricTags = {}): void {
    if (value < 0) {
      throw new Error(`MetricGauge value must be non-negative (got ${value})`);
    }
    native.setMetricGaugeValue(this.native, value, JSON.stringify(tags));
  }

  withTags(_tags: MetricTags): MetricGauge {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error('withTags is not supported directly on RuntimeMetricGauge');
  }
}

class RuntimeMetricGaugeF64 implements MetricGauge {
  public readonly kind = 'gauge';
  public readonly valueType = 'float';

  public constructor(
    private readonly native: native.MetricGaugeF64,
    public readonly name: string,
    public readonly unit: string,
    public readonly description: string
  ) {}

  set(value: number, tags: MetricTags = {}): void {
    if (value < 0) {
      throw new Error(`MetricGauge value must be non-negative (got ${value})`);
    }
    native.setMetricGaugeF64Value(this.native, value, JSON.stringify(tags));
  }

  withTags(_tags: MetricTags): MetricGauge {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error('withTags is not supported directly on RuntimeMetricGaugeF64');
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Buffered Metrics (aka lang-side metrics exporter)
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * A buffer that can be set on {@link RuntimeOptions.telemetry.metricsExporter} to record
 * metrics instead of ignoring/exporting them.
 *
 * It is important that the buffer size is set to a high number and that `retrieveUpdates` is
 * called regularly to drain the buffer. If the buffer is full, metric updates will be dropped
 * and an error will be logged.
 *
 * @experimental Buffered metrics is an experimental feature. APIs may be subject to change.
 */
export class MetricsBuffer {
  public readonly maxBufferSize: number;
  public readonly useSecondsForDurations: boolean;

  private runtime: Runtime | undefined = undefined;
  private pendingUpdates: BufferedMetricUpdate[] | undefined = undefined;

  public constructor(options: MetricsBufferOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 10000;
    this.useSecondsForDurations = options.useSecondsForDurations ?? false;
  }

  /**
   * Bind the MetricsBuffer to the given runtime.
   *
   * @internal
   * @hidden
   */
  bind(runtime: Runtime): MetricsBuffer {
    if (this.runtime !== undefined) {
      throw new IllegalStateError('MetricsBuffer already bound to a runtime');
    }
    this.runtime = runtime;
    return this;
  }

  /**
   * Unbind the MetricsBuffer from the given runtime.
   *
   * @internal
   * @hidden
   */
  unbind(runtime: Runtime): void {
    if (this.runtime !== undefined) {
      if (this.runtime !== runtime) throw new IllegalStateError('MetricsBuffer is bound to a different runtime');

      try {
        // We proactively drain buffered metrics from the native side, and keep them in the
        // pendingUpdates buffer until the user code calls retrieveUpdates(). Without this,
        // we would lose metric events on runtime shutdown.
        this.retrieveUpdatesInternal();
      } finally {
        this.runtime = undefined;
      }
    }
  }

  /**
   * Retrieve buffered metric updates.
   *
   * This method drains the metrics buffer and returns all metric events that have accumulated
   * since the last call to this method. This method should be called regularly when using
   * buffered metrics to prevent buffer overflow.
   *
   * @returns Array of buffered metric updates, each containing the metric metadata,
   *          current value, and attributes
   * @experimental Buffered metrics is an experimental feature. APIs may be subject to change.
   */
  public retrieveUpdates(): ArrayIterator<BufferedMetricUpdate> {
    this.retrieveUpdatesInternal();

    const updates = this.pendingUpdates ?? [];
    this.pendingUpdates = undefined;

    // We return an iterator instead of an array in case we should, at some point in the future,
    // need to apply per item transformation. Copying to an array would obviously be possible, the
    // buffered metric array might be large, so avoiding the extra array allocation makes sense.
    return updates.values();
  }

  /**
   * Fetch buffered metric updates from the native side, storing them in the pendingUpdates buffer.
   *
   * @internal
   * @hidden
   */
  private retrieveUpdatesInternal(): void {
    if (this.runtime === undefined) return;
    try {
      const updates = native.runtimeRetrieveBufferedMetrics(this.runtime.native);
      if (updates.length > 0) {
        if (this.pendingUpdates === undefined) {
          this.pendingUpdates = updates;
        } else {
          this.pendingUpdates.push(...updates);
        }
      }
    } catch (error) {
      // Ignore errors on retrieving buffered metrics after the runtime has been shut down.
      if (!(error instanceof IllegalStateError)) throw error;
    }
  }
}

export interface MetricsBufferOptions {
  /**
   * Maximum number of metric events to buffer before dropping new events.
   *
   * The buffer accumulates metric updates from Core and should be drained regularly by calling
   * {@link Runtime.retrieveBufferedMetrics}. If the buffer fills up, new metric updates will be
   * dropped and an error will be logged.
   *
   * @default 10000
   */
  maxBufferSize?: number;

  /**
   * If set to true, the exporter will use seconds for durations instead of milliseconds.
   *
   * @default false
   */
  useSecondsForDurations?: boolean;
}

/**
 * A single update event on a metric, recorded by buffered metrics exporter.
 *
 * When the {@link Runtime} is configured to buffer metrics, user code must regularly call
 * {@link MetricsBuffer.retrieveUpdates} to retrieve the buffered metric updates. Each update
 * event will be represented as a single instance of this interface.
 *
 * @experimental Buffered metrics is an experimental feature. APIs may be subject to change.
 */
export interface BufferedMetricUpdate {
  /**
   * The metric being updated.
   *
   * For performance reasons, the SDK tries to re-use the same object across updates for the same
   * metric. User code may take advantage of this, e.g. by attaching downstream metric references to
   * as a supplementary property on the `Metric` object. Note that the SDK may sometimes miss
   * deduplication opportunities, notably when a same metric is accessed from different execution
   * contexts (e.g. from both activity code and workflow code).
   */
  metric: Metric;

  /**
   * Value for this update event.
   *
   * For counters this is a delta; for gauges and histograms this is the value itself.
   */
  value: number;

  /**
   * Attributes for this update event.
   *
   * For performance reasons, the SDK tries to re-use the same object across updates for the same
   * attribute set. User code may take advantage of this, e.g. by attaching downstream attribute
   * sets references as a supplementary, _non-enumerable_ property on the `MetricTags` object. Make
   * sure however not to add, modify or delete any enumerable properties on the `MetricTags` object,
   * as those changes would affect future update events using the same `MetricTags` object, as well
   * as further events that extend that `MetricTags` object.
   *
   * Note that the SDK may miss deduplication opportunities, notably when a same set of attributes
   * is recreated by the code emitting the metric updates.
   */
  attributes: MetricTags;
}
