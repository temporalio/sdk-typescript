/**
 *  Contains definitions which correspond to the serde_json serialization of opentelemetry API
 *  types in Rust
 */

import Long from 'long';

/**
 * This is the top-level type representing an exported span. It must correspond with the
 * `serde_json` serialization of the `SpanData` type in the opentelemetry crate.
 */
export interface SerializedSpan {
  /// Span name
  name: string;
  /// Exportable `SpanContext`
  span_context: SpanContext;
  /// Span parent id
  parent_span_id: number;
  /// Span kind
  span_kind: string;
  /// Span start time
  start_time: SystemTime;
  /// Span end time
  end_time: SystemTime;
  /// Span attributes
  attributes: {
    map: {
      [attributeKey: string]: any;
    };
  };
  /// Span events
  events: PointlessQueue<Event>;
  /// Span Links
  links: PointlessQueue<Link>;
  /// Span status code
  status_code: string;
  /// Span status message
  status_message: string;
  /// Resource contains attributes representing an entity that produced this span.
  resource: {
    attrs: {
      [attributeKey: string]: any;
    };
  };
}

export interface SystemTime {
  secs_since_epoch: number;
  nanos_since_epoch: number;
}

export interface SpanContext {
  trace_id: Long;
  span_id: Long;
  trace_flags: number;
  is_remote: boolean;
}

export interface KVValue {
  I64?: number;
  F64?: number;
  Bool?: boolean;
  String?: string;
  Array?: any;
}

// The serde serialization of the rust OTel types is not done in a way that removes things that
// are pointless to serialize. This being a prime example.
export interface PointlessQueue<T> {
  queue?: T[];
}

export interface Event {
  name: string;
  timestamp: SystemTime;
  attributes: KeyValue[];
  dropped_attributes_count: number;
}

export interface KeyValue {
  key: string;
  value: KVValue;
}

export interface Link {
  span_context: SpanContext;
  attributes: KeyValue[];
  dropped_attributes_count: number;
}
