const { GITHUB_TOKEN } = process.env;

if (GITHUB_TOKEN) {
  console.log(`Using GITHUB_TOKEN env var for downloading from GitHub`);
}

export const headers: Record<string, string> = {
  'User-Agent': '@temporalio/create project initializer',
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : undefined),
};
