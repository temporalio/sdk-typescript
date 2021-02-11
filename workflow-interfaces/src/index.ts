export interface SimpleQuery {
  main(): void;
  queries: {
    hasSlept(): boolean;
    hasSleptAsync() : Promise<boolean>;
  };
}

export interface ArgsAndReturn {
  main(greeting: string, _skip: undefined, arr: ArrayBuffer): Promise<string>;
}
