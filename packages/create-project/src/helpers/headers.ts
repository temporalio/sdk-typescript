const { GITHUB_TOKEN } = process.env;

export const headers: Record<string, string> = {
  'User-Agent': '@temporalio/create project initializer',
};

if (GITHUB_TOKEN) {
  console.log(`Using GITHUB_TOKEN`);
  headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
}
