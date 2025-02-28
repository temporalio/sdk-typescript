import {
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  MetricMeter,
  MetricTags,
  NumericMetricValueType,
} from '@temporalio/common';
import { mergeObjects, filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';

export type MetricTagsOrFunc = MetricTags | (() => MetricTags);

export class MetricsMeterWithComposedTags implements MetricMeter {
  /**
   * Return a MetricMeter that adds tags before delegating calls to a parent meter.
   *
   * New tags may either be specified statically as a delta object, or as a function
   * evaluated every time a metric is recorded that will return a delta object.
   *
   * Performs various optimizations to avoid creating unnecessary objects and to
   * keep runtime overhead associated with resolving tags as low as possible.
   */
  public static compose(meter: MetricMeter, tagsOrFunc: MetricTagsOrFunc): MetricMeter {
    if (meter instanceof MetricsMeterWithComposedTags) {
      const contributors = appendToChain(meter.contributors, tagsOrFunc);
      // If the new contributor results in no actual change to the chain, then we don't need a new meter
      if (contributors === undefined) return meter;
      return new MetricsMeterWithComposedTags(meter.parentMeter, contributors);
    } else {
      const contributors = appendToChain(undefined, tagsOrFunc);
      if (contributors === undefined) return meter;
      return new MetricsMeterWithComposedTags(meter, contributors);
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
    return MetricsMeterWithComposedTags.compose(this, tags);
  }
}

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
