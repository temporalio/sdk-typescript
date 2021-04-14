const path = require('path');
const typedoc = require('typedoc');

const docsDir = path.resolve(__dirname, '../docs');

/// Generate docs for a single package.
/// This may not run concurrently because it changes the directory to the package root
async function genDocs(package = 'meta', outputDir) {
  const root = path.resolve(__dirname, '../packages', package);
  const oldpwd = process.cwd();
  try {
    process.chdir(root);

    const app = new typedoc.Application();
    app.options.addReader(new typedoc.TSConfigReader());

    app.bootstrap({
      tsconfig: 'tsconfig.json',
      entryPoints: ['src/index.ts'],
      excludePrivate: true,
      excludeProtected: true,
      hideGenerator: true,
      disableSources: true,
      hideBreadcrumbs: true,
    });

    const project = app.convert();

    // Project may not have converted correctly
    if (!project) {
      throw new Error('Failed to convert app');
    }

    // Rendered docs
    await app.generateDocs(project, outputDir);
  } finally {
    process.chdir(oldpwd);
  }
}

async function main() {
  const outputDir = process.argv[2];
  if (!outputDir) {
    throw new Error('Usage: gen-docs <outputDir>');
  }
  await genDocs('meta', outputDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
