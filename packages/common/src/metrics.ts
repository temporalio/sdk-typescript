import { filterNullAndUndefined, mergeObjects } from './internal-workflow';

/**
 * A meter for creating metrics to record values on.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
export interface MetricMeter {
  /**
   * Create a new counter metric that supports adding values.
   *
   * @param name Name for the counter metric.
   * @param unit Unit for the counter metric. Optional.
   * @param description Description for the counter metric. Optional.
   */
  createCounter(name: string, unit?: string, description?: string): MetricCounter;

  /**
   * Create a new histogram metric that supports recording values.
   *
   * @param name Name for the histogram metric.
   * @param valueType Type of value to record. Defaults to `int`.
   * @param unit Unit for the histogram metric. Optional.
   * @param description Description for the histogram metric. Optional.
   */
  createHistogram(
    name: string,
    valueType?: NumericMetricValueType,
    unit?: string,
    description?: string
  ): MetricHistogram;

  /**
   * Create a new gauge metric that supports setting values.
   *
   * @param name Name for the gauge metric.
   * @param valueType Type of value to set. Defaults to `int`.
   * @param unit Unit for the gauge metric. Optional.
   * @param description Description for the gauge metric. Optional.
   */
  createGauge(name: string, valueType?: NumericMetricValueType, unit?: string, description?: string): MetricGauge;

  /**
   * Return a clone of this meter, with additional tags. All metrics created off the meter will
   * have the tags.
   *
   * @param tags Tags to append.
   */
  withTags(tags: MetricTags): MetricMeter;
}

/**
 * Base interface for all metrics.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
export interface Metric {
  /**
   * The name of the metric.
   */
  name: string;

  /**
   * The unit of the metric, if any.
   */
  unit?: string;

  /**
   * The description of the metric, if any.
   */
  description?: string;
}

/**
 * A metric that supports adding values as a counter.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
export interface MetricCounter extends Metric {
  /**
   * Add the given value to the counter.
   *
   * @param value Value to add.
   * @param extraTags Extra tags if any.
   */
  add(value: number, extraTags?: MetricTags): void;

  /**
   * Return a clone of this counter, with additional tags.
   *
   * @param tags Tags to append to existing tags.
   */
  withTags(tags: MetricTags): MetricCounter;
}

/**
 * A metric that supports recording values on a histogram.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
export interface MetricHistogram extends Metric {
  /**
   * The type of value to record. Either `int` or `float`.
   */
  valueType: NumericMetricValueType;

  /**
   * Record the given value on the histogram.
   *
   * @param value Value to record. Must be a non-negative number. Value will be casted to the given
   *              {@link valueType}. Loss of precision may occur if the value is not already of the
   *              correct type.
   * @param extraTags Extra tags if any.
   */
  record(value: number, extraTags?: MetricTags): void;

  /**
   * Return a clone of this histogram, with additional tags.
   *
   * @param tags Tags to append to existing tags.
   */
  withTags(tags: MetricTags): MetricHistogram;
}

/**
 * A metric that supports setting values.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
export interface MetricGauge extends Metric {
  /**
   * The type of value to set. Either `int` or `float`.
   */
  valueType: NumericMetricValueType;

  /**
   * Set the given value on the gauge.
   *
   * @param value Value to set.
   * @param extraTags Extra tags if any.
   */
  set(value: number, extraTags?: MetricTags): void;

  /**
   * Return a clone of this gauge, with additional tags.
   *
   * @param tags Tags to append to existing tags.
   */
  withTags(tags: MetricTags): MetricGauge;
}

/**
 * Tags to be attached to some metrics.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
export type MetricTags = Record<string, string | number | boolean>;

export type NumericMetricValueType = 'int' | 'float';

////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * A meter implementation that does nothing.
 */
class NoopMetricMeter implements MetricMeter {
  createCounter(name: string, unit?: string, description?: string): MetricCounter {
    return {
      name,
      unit,
      description,

      add(_value, _extraTags) {},

      withTags(_extraTags) {
        return this;
      },
    };
  }

  createHistogram(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit?: string,
    description?: string
  ): MetricHistogram {
    return {
      name,
      valueType,
      unit,
      description,

      record(_value, _extraTags) {},

      withTags(_extraTags) {
        return this;
      },
    };
  }

  createGauge(name: string, valueType?: NumericMetricValueType, unit?: string, description?: string): MetricGauge {
    return {
      name,
      valueType: valueType ?? 'int',
      unit,
      description,

      set(_value, _extraTags) {},

      withTags(_extraTags) {
        return this;
      },
    };
  }

  withTags(_extraTags: MetricTags): MetricMeter {
    return this;
  }
}

export const noopMetricMeter = new NoopMetricMeter();

////////////////////////////////////////////////////////////////////////////////////////////////////

export type MetricTagsOrFunc = MetricTags | (() => MetricTags);

/**
 * A meter implementation that adds tags before delegating calls to a parent meter.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 * @internal
 * @hidden
 */
export class MetricMeterWithComposedTags implements MetricMeter {
  /**
   * Return a {@link MetricMeter} that adds tags before delegating calls to a parent meter.
   *
   * New tags may either be specified statically as a delta object, or as a function evaluated
   * every time a metric is recorded that will return a delta object.
   *
   * Some optimizations are performed to avoid creating unnecessary objects and to keep runtime
   * overhead associated with resolving tags as low as possible.
   *
   * @param meter The parent meter to delegate calls to.
   * @param tagsOrFunc New tags may either be specified statically as a delta object, or as a function
   *                   evaluated every time a metric is recorded that will return a delta object.
   * @param force if `true`, then a `MetricMeterWithComposedTags` will be created even if there
   *              is no tags to add. This is useful to add tags support to an underlying meter
   *              implementation that does not support tags directly.
   */
  public static compose(meter: MetricMeter, tagsOrFunc: MetricTagsOrFunc, force: boolean = false): MetricMeter {
    if (meter instanceof MetricMeterWithComposedTags) {
      const contributors = appendToChain(meter.contributors, tagsOrFunc);
      // If the new contributor results in no actual change to the chain, then we don't need a new meter
      if (contributors === undefined && !force) return meter;
      return new MetricMeterWithComposedTags(meter.parentMeter, contributors ?? []);
    } else {
      const contributors = appendToChain(undefined, tagsOrFunc);
      if (contributors === undefined && !force) return meter;
      return new MetricMeterWithComposedTags(meter, contributors ?? []);
    }
  }

  private constructor(
    private readonly parentMeter: MetricMeter,
    private readonly contributors: MetricTagsOrFunc[]
  ) {}

  createCounter(name: string, unit?: string, description?: string): MetricCounter {
    const parentCounter = this.parentMeter.createCounter(name, unit, description);
    return new MetricCounterWithComposedTags(parentCounter, this.contributors);
  }

  createHistogram(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit?: string,
    description?: string
  ): MetricHistogram {
    const parentHistogram = this.parentMeter.createHistogram(name, valueType, unit, description);
    return new MetricHistogramWithComposedTags(parentHistogram, this.contributors);
  }

  createGauge(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit?: string,
    description?: string
  ): MetricGauge {
    const parentGauge = this.parentMeter.createGauge(name, valueType, unit, description);
    return new MetricGaugeWithComposedTags(parentGauge, this.contributors);
  }

  withTags(tags: MetricTags): MetricMeter {
    return MetricMeterWithComposedTags.compose(this, tags);
  }
}

/**
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
class MetricCounterWithComposedTags implements MetricCounter {
  constructor(
    private parentCounter: MetricCounter,
    private contributors: MetricTagsOrFunc[]
  ) {}

  add(value: number, extraTags?: MetricTags | undefined): void {
    this.parentCounter.add(value, resolveTags(this.contributors, extraTags));
  }

  withTags(extraTags: MetricTags): MetricCounter {
    const contributors = appendToChain(this.contributors, extraTags);
    if (contributors === undefined) return this;
    return new MetricCounterWithComposedTags(this.parentCounter, contributors);
  }

  get name(): string {
    return this.parentCounter.name;
  }

  get unit(): string | undefined {
    return this.parentCounter.unit;
  }

  get description(): string | undefined {
    return this.parentCounter.description;
  }
}

/**
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
class MetricHistogramWithComposedTags implements MetricHistogram {
  constructor(
    private parentHistogram: MetricHistogram,
    private contributors: MetricTagsOrFunc[]
  ) {}

  record(value: number, extraTags?: MetricTags): void {
    this.parentHistogram.record(value, resolveTags(this.contributors, extraTags));
  }

  withTags(extraTags: MetricTags): MetricHistogram {
    const contributors = appendToChain(this.contributors, extraTags);
    if (contributors === undefined) return this;
    return new MetricHistogramWithComposedTags(this.parentHistogram, contributors);
  }

  get name(): string {
    return this.parentHistogram.name;
  }

  get valueType(): NumericMetricValueType {
    return this.parentHistogram.valueType;
  }

  get unit(): string | undefined {
    return this.parentHistogram.unit;
  }

  get description(): string | undefined {
    return this.parentHistogram.description;
  }
}

/**
 * @internal
 * @hidden
 */
class MetricGaugeWithComposedTags implements MetricGauge {
  constructor(
    private parentGauge: MetricGauge,
    private contributors: MetricTagsOrFunc[]
  ) {}

  set(value: number, extraTags?: MetricTags): void {
    this.parentGauge.set(value, resolveTags(this.contributors, extraTags));
  }

  withTags(extraTags: MetricTags): MetricGauge {
    const contributors = appendToChain(this.contributors, extraTags);
    if (contributors === undefined) return this;
    return new MetricGaugeWithComposedTags(this.parentGauge, contributors);
  }

  get name(): string {
    return this.parentGauge.name;
  }

  get valueType(): NumericMetricValueType {
    return this.parentGauge.valueType;
  }

  get unit(): string | undefined {
    return this.parentGauge.unit;
  }

  get description(): string | undefined {
    return this.parentGauge.description;
  }
}

function resolveTags(contributors: MetricTagsOrFunc[], extraTags?: MetricTags): MetricTags {
  const resolved = {};
  for (const contributor of contributors) {
    Object.assign(resolved, typeof contributor === 'function' ? contributor() : contributor);
  }
  Object.assign(resolved, extraTags);
  return filterNullAndUndefined(resolved);
}

/**
 * Append a tags contributor to the chain, merging it with the former last contributor if possible.
 *
 * If appending the new contributor results in no actual change to the chain of contributors, return
 * `existingContributors`; in that case, the caller should avoid creating a new object if possible.
 */
function appendToChain(
  existingContributors: MetricTagsOrFunc[] | undefined,
  newContributor: MetricTagsOrFunc
): MetricTagsOrFunc[] | undefined {
  // If the new contributor is an empty object, then it results in no actual change to the chain
  if (typeof newContributor === 'object' && Object.keys(newContributor).length === 0) {
    return existingContributors;
  }

  // If existing chain is empty, then the new contributor is the chain
  if (existingContributors == null || existingContributors.length === 0) {
    return [newContributor];
  }

  // If both last contributor and new contributor are plain objects, merge them to a single object.
  const last = existingContributors[existingContributors.length - 1];
  if (typeof last === 'object' && typeof newContributor === 'object') {
    const merged = mergeObjects(last, newContributor);
    if (merged === last) return existingContributors;
    return [...existingContributors.slice(0, -1), merged!];
  }

  // Otherwise, just append the new contributor to the chain.
  return [...existingContributors, newContributor];
}
