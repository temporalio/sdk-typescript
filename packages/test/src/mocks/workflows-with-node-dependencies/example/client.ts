import dns from 'dns';

export function exampleHeavyweightFunction(): void {
  dns.resolve('localhost', () => {
    /* ignore */
  });
}
