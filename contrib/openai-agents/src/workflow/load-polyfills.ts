// Web-API polyfills agents-core needs on the Workflow sandbox globalThis. Installed via preload-polyfills.

import { Headers } from 'headers-polyfill';
import { uuid4 } from '@temporalio/workflow';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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

  // agents-core's base64 codec (encodeUint8ArrayToBase64/decodeBase64ToUint8Array)
  // falls back to `btoa`/`atob` when `Buffer` is absent, as it is in the isolate.
  if (typeof (globalThis as any).atob === 'undefined') {
    (globalThis as any).atob = (data: string): string => {
      let binary = '';
      const clean = data.replace(/[^A-Za-z0-9+/]/g, '');
      for (let i = 0; i < clean.length; i += 4) {
        const e1 = BASE64_CHARS.indexOf(clean[i]!);
        const e2 = BASE64_CHARS.indexOf(clean[i + 1] ?? 'A');
        const e3 = clean[i + 2] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 2]!);
        const e4 = clean[i + 3] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 3]!);
        binary += String.fromCharCode((e1 << 2) | (e2 >> 4));
        if (e3 >= 0) binary += String.fromCharCode(((e2 & 0xf) << 4) | (e3 >> 2));
        if (e4 >= 0) binary += String.fromCharCode(((e3 & 0x3) << 6) | e4);
      }
      return binary;
    };
  }
  if (typeof (globalThis as any).btoa === 'undefined') {
    (globalThis as any).btoa = (binary: string): string => {
      let result = '';
      for (let i = 0; i < binary.length; i += 3) {
        const c1 = binary.charCodeAt(i);
        const c2 = i + 1 < binary.length ? binary.charCodeAt(i + 1) : NaN;
        const c3 = i + 2 < binary.length ? binary.charCodeAt(i + 2) : NaN;
        result += BASE64_CHARS[c1 >> 2]!;
        result += BASE64_CHARS[((c1 & 0x3) << 4) | (Number.isNaN(c2) ? 0 : c2 >> 4)]!;
        result += Number.isNaN(c2) ? '=' : BASE64_CHARS[((c2 & 0xf) << 2) | (Number.isNaN(c3) ? 0 : c3 >> 6)]!;
        result += Number.isNaN(c3) ? '=' : BASE64_CHARS[c3 & 0x3f]!;
      }
      return result;
    };
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
