export interface ActivityOptions {
  retries: number;
}

export type Fn<TArgs extends any[], TRet> = (...args: TArgs) => TRet;

export interface Activity<F extends Fn<any[], Promise<any>>> {
  (...args: Parameters<F>): ReturnType<F>;
  withOptions(options: ActivityOptions): { invoke: F };
}
