import { Headers } from 'headers-polyfill';
import { inWorkflowContext, uuid4 } from '@temporalio/workflow';

if (inWorkflowContext()) {
  // Headers polyfill (shared with ai-sdk)
  if (typeof globalThis.Headers === 'undefined') {
    (globalThis as any).Headers = Headers;
  }

  // ReadableStream polyfill (shared with ai-sdk)
  // eslint-disable-next-line @typescript-eslint/no-require-imports,import/no-unassigned-import
  require('web-streams-polyfill/polyfill');

  // structuredClone polyfill (shared with ai-sdk)
  if (!('structuredClone' in globalThis)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sc = require('@ungap/structured-clone');
    (globalThis as any).structuredClone = sc.default;
  }

  // crypto.randomUUID polyfill — agents-core calls this internally even with tracing disabled.
  // Uses Temporal's deterministic uuid4() which is backed by a per-workflow seeded PRNG,
  // ensuring replay safety and per-workflow isolation.
  if (typeof (globalThis as any).crypto === 'undefined') {
    (globalThis as any).crypto = {};
  }
  if (!(globalThis as any).crypto.randomUUID) {
    let fallbackCounter = 0;
    (globalThis as any).crypto.randomUUID = (): string => {
      try {
        return uuid4();
      } catch {
        const c = (fallbackCounter++).toString(16).padStart(12, '0');
        return `00000000-0000-4000-8000-${c}`;
      }
    };
  }

  // EventTarget polyfill — agents-core uses EventTarget internally for event handling
  if (typeof (globalThis as any).EventTarget === 'undefined') {
    (globalThis as any).EventTarget = class EventTargetPolyfill {
      _listeners: Record<string, Array<(event: any) => void>> = {};

      addEventListener(type: string, listener: (event: any) => void): void {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(listener);
      }

      removeEventListener(type: string, listener: (event: any) => void): void {
        const arr = this._listeners[type];
        if (arr) this._listeners[type] = arr.filter((l) => l !== listener);
      }

      dispatchEvent(event: any): boolean {
        (event as any).target = this;
        (event as any).currentTarget = this;
        const arr = this._listeners[event.type];
        if (arr) {
          arr.forEach((l) => {
            try {
              l(event);
            } catch {
              // Isolate listener errors — one bad listener shouldn't break dispatch
            }
          });
        }
        return true;
      }
    };
  }

  // Event polyfill
  if (typeof (globalThis as any).Event === 'undefined') {
    (globalThis as any).Event = class EventPolyfill {
      type: string;
      bubbles: boolean;
      cancelable: boolean;

      constructor(type: string, opts?: { bubbles?: boolean; cancelable?: boolean }) {
        this.type = type;
        this.bubbles = opts?.bubbles ?? false;
        this.cancelable = opts?.cancelable ?? false;
      }
    };
  }

  // CustomEvent polyfill
  if (typeof (globalThis as any).CustomEvent === 'undefined') {
    const EventClass = (globalThis as any).Event;
    (globalThis as any).CustomEvent = class CustomEventPolyfill extends EventClass {
      detail: any;

      constructor(type: string, opts?: { bubbles?: boolean; cancelable?: boolean; detail?: any }) {
        super(type, opts);
        this.detail = opts?.detail ?? null;
      }
    };
  }
}
