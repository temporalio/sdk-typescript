const path = require('path');
const typedoc = require('typedoc');

const docsDir = path.resolve(__dirname, '../docs');

/// Generate docs for a single package.
// This many not run concurrently because it changes the directory to the package root
async function genDocs(package) {
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
    });

    const project = app.convert();

    if (!project) {
      throw new Error('Failed to convert app');
    }
    // Project may not have converted correctly
    const outputDir = path.resolve(docsDir, package);

    // Rendered docs
    await app.generateDocs(project, outputDir);
  } finally {
    process.chdir(oldpwd);
  }
}

async function main() {
  let packages = process.argv.slice(2);
  if (packages.length === 0) {
    packages = ['worker', 'client'];
  }
  for (const package of packages) {
    await genDocs(package);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
