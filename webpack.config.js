module.exports = {
  entry: ['./packages/workflow/es2020/init.js', './packages/test-workflows/lib/sync.js'],
  mode: 'development',
  output: {
    library: 'lib',
    filename: '[name].js',
  },
};
