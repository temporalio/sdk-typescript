import dns from 'dns'; // DO NOT ADD node: prefix on this import

export function exampleHeavyweightFunction(): void {
  dns.resolve('localhost', () => {
    /* ignore */
  });
}
