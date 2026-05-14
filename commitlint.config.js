module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['activity', 'perf', 'client', 'docs', 'core', 'release', 'create-project', 'worker', 'workflow', 'proto'],
    ],
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [2, 'always', 120],
  },
};
