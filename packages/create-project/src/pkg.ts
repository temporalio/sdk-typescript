import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export default pkg as { name: string; version: string };
