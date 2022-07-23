import { glob } from 'glob';
import path from 'path';
import { readFile, writeFile } from 'fs/promises';

export async function stripSnipComments(root: string): Promise<void> {
  const files = glob.sync('**/*.ts', { cwd: root });
  await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(root, file);
      const fileString = await readFile(filePath, 'utf8');
      await writeFile(filePath, fileString.replace(/ *\/\/ @@@SNIP.+\n/g, ''));
    })
  );
}
