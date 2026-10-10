import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // src/main.ts carries the shebang; esbuild keeps it as the first line of the bundle.
  noExternal: [/^@mpf\//],
  esbuildPlugins: [
    {
      // esbuild rewrites `node:sqlite` to `sqlite` (it is newer than its builtin list); keep every node: import verbatim.
      name: 'keep-node-prefix',
      setup(build) {
        build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }))
      },
    },
  ],
})
