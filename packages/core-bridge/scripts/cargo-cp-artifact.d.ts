declare const run: (args: string[], env: Record<string, string | undefined>) => void;

declare module 'cargo-cp-artifact' {
  export = run;
}
