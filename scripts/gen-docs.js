const path = require('path');
const typedoc = require('typedoc');

async function main() {
  const root = path.resolve(__dirname, '../packages/worker');
  const docsDir = path.resolve(__dirname, '../docs');
  const oldpwd = process.cwd();
  try {
    process.chdir(root);

    const app = new typedoc.Application();
    app.options.addReader(new typedoc.TSConfigReader());

    // "docs": "(cd packages/worker && typedoc --out ../../docs/api --excludeProtected --entryPoints src/index.ts tsconfig.json)"
    //
    app.bootstrap({
      tsconfig: 'tsconfig.json',
      entryPoints: ['src/index.ts'],
      excludePrivate: true,
      excludeProtected: true,
    });

    const project = app.convert();

    if (!project) {
      throw new Error('Failed to convert app');
    }
    // Project may not have converted correctly
    const outputDir = path.resolve(docsDir, 'worker');

    // Rendered docs
    await app.generateDocs(project, outputDir);
  } finally {
    process.chdir(oldpwd);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
