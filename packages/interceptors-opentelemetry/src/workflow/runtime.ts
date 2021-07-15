/**
 * Sets global variables required for importing opentelemetry in isolate
 * @module
 */

// Required by opentelemetry (pretend to be a browser)
(globalThis as any).performance = {
  timeOrigin: Date.now(),
  now: Date.now,
};
(globalThis as any).window = globalThis;
