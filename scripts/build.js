import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['index.js'],
  outfile: 'dist/index.js',
  format: 'esm',
  bundle: true,
  platform: 'browser',
  sourcemap: false,
  minifyWhitespace: true,
  target: 'es2022',
})
