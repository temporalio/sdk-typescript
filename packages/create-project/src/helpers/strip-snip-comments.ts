import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { sync } from 'glob';

export async function stripSnipComments(root: string): Promise<void> {
  const files = sync('**/*.ts', { cwd: root });
  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(root, file);
      const fileString = await readFile(filePath, 'utf8');
      await writeFile(filePath, fileString.replace(/ *\/\/ @@@SNIP.+\n/g, ''));
    })
  );
}
