// Web-API polyfills agents-core needs on the Workflow sandbox globalThis. Installed via preload-polyfills.

import { Headers } from 'headers-polyfill';
import { uuid4 } from '@temporalio/workflow';

export class EventTargetPolyfill {
  private _listeners: Record<string, Array<(event: any) => void>> = {};

  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const arr = this._listeners[type];
    if (arr) this._listeners[type] = arr.filter((l) => l !== listener);
  }

  dispatchEvent(event: { type: string }): boolean {
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
}

export function installPolyfills(): void {
  if (typeof globalThis.Headers === 'undefined') {
    (globalThis as any).Headers = Headers;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports,import/no-unassigned-import
  require('web-streams-polyfill/polyfill');

  if (!('structuredClone' in globalThis)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sc = require('@ungap/structured-clone');
    (globalThis as any).structuredClone = sc.default;
  }

  if (typeof (globalThis as any).crypto === 'undefined') {
    (globalThis as any).crypto = {};
  }
  if (!(globalThis as any).crypto.randomUUID) {
    (globalThis as any).crypto.randomUUID = (): string => uuid4();
  }

  // The sandbox exposes AbortController but not the AbortSignal global; agents-core's
  // streaming path references AbortSignal directly. Derive it from a controller's signal.
  if (typeof (globalThis as any).AbortSignal === 'undefined' && typeof globalThis.AbortController !== 'undefined') {
    (globalThis as any).AbortSignal = new globalThis.AbortController().signal.constructor;
  }

  if (typeof (globalThis as any).EventTarget === 'undefined') {
    (globalThis as any).EventTarget = EventTargetPolyfill;
  }

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
