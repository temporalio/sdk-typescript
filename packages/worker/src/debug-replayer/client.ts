import http from 'node:http';
import pkg from '../pkg';

interface ClientOptions {
  baseUrl: string;
}

/**
 * "High level" HTTP client, used to avoid adding more dependencies to the worker package.
 *
 * DO NOT use this in a real application, it's meant to only be used for calling a "runner" (e.g. VS Code debugger
 * extension).
 */
export class Client {
  constructor(public readonly options: ClientOptions) {}

  async post(url: string, options: http.RequestOptions, body: Buffer): Promise<http.IncomingMessage> {
    const request = http.request(`${this.options.baseUrl}/${url}`, {
      ...options,
      method: 'POST',
      headers: {
        'Temporal-Client-Name': 'temporal-typescript',
        'Temporal-Client-Version': pkg.version,
        'Content-Length': body.length,
        ...options?.headers,
      },
    });
    if (body) {
      await new Promise<void>((resolve, reject) => {
        request.once('error', reject);
        request.write(body, (err) => {
          request.off('error', reject);
          if (err) {
            reject();
          } else {
            resolve();
          }
        });
        request.end();
      });
    }
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', resolve);
    });
    if (response.statusCode !== 200) {
      let message = response.statusMessage;
      try {
        const responseBody = await Client.readAll(response);
        message = JSON.parse(responseBody.toString())?.error ?? message;
      } catch {
        // ignore
      }
      throw new Error(`Bad response code from VS Code: ${response.statusCode}: ${message}`);
    }
    return response;
  }

  async get(url: string, options?: http.RequestOptions): Promise<http.IncomingMessage> {
    const request = http.get(`${this.options.baseUrl}/${url}`, {
      ...options,
      headers: {
        'Temporal-Client-Name': 'temporal-typescript',
        'Temporal-Client-Version': pkg.version,
        ...options?.headers,
      },
    });
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', resolve);
    });
    if (response.statusCode !== 200) {
      let message = response.statusMessage;
      try {
        const responseBody = await Client.readAll(response);
        message = JSON.parse(responseBody.toString())?.error ?? message;
      } catch {
        // ignore
      }
      throw new Error(`Bad response code from VS Code: ${response.statusCode}: ${message}`);
    }
    return response;
  }

  static async readAll(response: http.IncomingMessage): Promise<Buffer> {
    const chunks = Array<Buffer>();
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  static contentLength(response: http.IncomingMessage): number {
    const contentLength = response.headers['content-length'];
    if (!contentLength) {
      throw new Error('Empty response body when getting history');
    }
    return parseInt(contentLength);
  }
}
