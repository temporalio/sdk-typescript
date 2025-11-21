import {
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  MetricMeter,
  MetricTags,
  NumericMetricValueType,
} from '@temporalio/common';
import { native } from '@temporalio/core-bridge';

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
