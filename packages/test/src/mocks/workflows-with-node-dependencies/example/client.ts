import dns from 'dns';
import http from 'node:http';

export function exampleHeavyweightFunction(): void {
  // Dummy code, only to ensure dependencies on 'dns' and 'node:http' do not get removed.
  // This code will actually never run.
  dns.resolve('localhost', () => {
    http.get('localhost');
  });
}
