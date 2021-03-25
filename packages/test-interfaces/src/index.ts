export interface SimpleQuery {
  main(): void;
  queries: {
    hasSlept(): boolean;
    hasSleptAsync(): Promise<boolean>;
    // Used to fail the query
    fail(): never;
  };
}

export interface ArgsAndReturn {
  main(greeting: string, _skip: undefined, arr: ArrayBuffer): Promise<string>;
}

export interface HTTP {
  main(): Promise<string[]>;
}

export interface Empty {
  main(): Promise<void>;
}
