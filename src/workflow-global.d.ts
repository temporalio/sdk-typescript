import { Activity as _Activity, Fn } from './activity';
export {}

declare global {
  export interface Console {
    log(...args: any[]): void;
  }

  export var console: Console;
  export function setTimeout(cb: (...args: any[]) => any, ms: number, ...args: any[]): number;
  export function clearTimeout(handle: number): void;
  export interface Activity<F extends Fn<any[], Promise<any>>> extends _Activity<F> {}
}
