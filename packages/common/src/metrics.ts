export type MetricTags = Record<string, string | number | boolean>;

export type NumericMetricValueType = 'int' | 'float';

/**
 * Base interface for all metrics.
 */
export interface Metric {
  /**
   * The name for the metric.
   */
  name: string;

  /**
   * The unit for the metric, if any.
   */
  unit?: string;

  /**
   * The description for the metric, if any.
   */
  description?: string;
}

/**
 * Metric for adding values as a counter.
 */
export interface MetricCounter extends Metric {
  /**
   * Add the given value to the counter.
   *
   * @param value Value to add.
   * @param extraTags Extra tags if any. If this is called multiple times with the same tags,
   *                  use `withTags` for better performance.
   */
  add(value: number, extraTags?: MetricTags): void;

  /**
   * Create a new counter with the given tags.
   *
   * @param tags Tags to append to existing tags.
   */
  withTags(tags: MetricTags): MetricCounter;
}

/**
 * Metric for recording values on a histogram.
 */
export interface MetricHistogram extends Metric {
  /**
   * The type of value to record. Either `int` or `float`.
   */
  valueType: NumericMetricValueType;

  /**
   * Record the given value on the histogram.
   *
   * FIXME: Assert that value must be a non-negative integer
   * FIXME: Also check other types of values
   * @param value Value to record. Must be a non-negative integer.
   * @param extraTags Extra tags if any. If this is called multiple times with the same tags,
   *                  use `withTags` for better performance.
   */
  record(value: number, extraTags?: MetricTags): void;

  /**
   * Create a new histogram with the given tags.
   *
   * @param tags Tags to append to existing tags.
   */
  withTags(tags: MetricTags): MetricHistogram;
}

/**
 * Metric for setting values on a gauge.
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
   * @param extraTags Extra tags if any. If this is called multiple times with the same tags,
   *                  use `withTags` for better performance.
   */
  set(value: number, extraTags?: MetricTags): void;

  /**
   * Create a new gauge with the given tags.
   *
   * @param tags Tags to append to existing tags.
   */
  withTags(tags: MetricTags): MetricGauge;
}

/**
 * Meter for creating metrics to record values on.
 */
export interface MetricMeter {
  /**
   * Create a new counter metric for adding values.
   *
   * @param name Name for the counter metric.
   * @param unit Unit for the counter metric if any.
   * @param description Description for the counter metric if any.
   */
  createCounter(name: string, unit?: string, description?: string): MetricCounter;

  /**
   * Create a new histogram metric for recording values.
   *
   * @param name Name for the histogram metric.
   * @param valueType Type of value to record. Defaults to `int`.
   * @param unit Unit for the histogram metric if any.
   * @param description Description for the histogram metric if any.
   */
  createHistogram(
    name: string,
    valueType?: NumericMetricValueType,
    unit?: string,
    description?: string
  ): MetricHistogram;

  /**
   * Create a new gauge metric for setting values.
   *
   * @param name Name for the gauge metric.
   * @param valueType Type of value to set. Defaults to `int`.
   * @param unit Unit for the gauge metric if any.
   * @param description Description for the gauge metric if any.
   */
  createGauge(name: string, valueType?: NumericMetricValueType, unit?: string, description?: string): MetricGauge;

  /**
   * Create a new meter with the given tags appended. All metrics created off the meter will have the tags.
   *
   * @param tags Tags to append.
   */
  withTags(tags: MetricTags): MetricMeter;
}

class NoopMetricMeter implements MetricMeter {
  createCounter(name: string, unit?: string, description?: string): MetricCounter {
    return {
      name,
      unit,
      description,

      add(_value, _extraTags) {
        /**/
      },

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

      record(_value, _extraTags) {
        /**/
      },

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

      set(_value, _extraTags) {
        /**/
      },

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
