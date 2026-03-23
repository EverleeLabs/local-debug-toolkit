// webpack.config.js
const path = require('path');

module.exports = [
  // Renderer (UI) - main.ts is compiled separately with tsc
  {
    mode: 'production',
    target: 'electron-renderer',
    entry: { renderer: path.resolve(__dirname, 'src/renderer.jsx') },
    output: {
      path: path.resolve(__dirname, 'lib'),
      filename: 'renderer.js',
      libraryTarget: 'commonjs2',
    },
    resolve: { extensions: ['.js', '.jsx'] },
    externals: [
      function ({ context, request }, callback) {
        // Handle @getflywheel/local-components as external
        if (request === '@getflywheel/local-components') {
          return callback(null, 'commonjs @getflywheel/local-components');
        }
        // Let webpack handle everything else
        callback();
      },
    ],
    externalsType: 'commonjs',
    module: {
      rules: [
        {
          test: /\.jsx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
          },
        },
      ],
    },
  },
];
