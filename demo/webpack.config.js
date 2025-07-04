module.exports = {
  entry: './public/app.js',
  output: {
    path: __dirname + '/build',
    filename: 'app.js',
    chunkFormat: 'commonjs'
  },
  devServer: {
    static: './build',
    allowedHosts: 'all'
  },
  target: "es5",
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.m?js$/,
        exclude: /(node_modules|browser-build|bower_components)/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [['@babel/preset-env',
              {
                targets: {
                  browsers: 'ie >= 11'
                }
              }
            ]]
          }
        }
      },
      {
        test: /\.css$/,
        use: [
          'style-loader',
          'css-loader'
        ]
      },
      {
        test: /\.html$/,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: 'index.html'
            },
          },
        ]
      },
      {
        test: /\.yaml$/,
        use: [
          { loader: 'json-loader' },
          { loader: 'yaml-loader' }
        ]
      }

    ]
  }
}
