import { URL, fileURLToPath } from 'node:url';
import os from 'node:os';

const ext = os.platform() === 'win32' ? '.exe' : '';
export const outputPath = fileURLToPath(new URL(`../test-server${ext}`, import.meta.url));
