import { defineConfig } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default defineConfig({
  input: './src/y-redis.js',
  output: [
    {
      file: './dist/y-redis.mjs',
      format: 'esm',
      sourcemap: true,
    },
    {
      file: './dist/y-redis.cjs',
      format: 'cjs',
      sourcemap: true,
    },
  ],
  external: (id) => /^(lib0|yjs|ioredis)/.test(id),
  plugins: [nodeResolve(), commonjs(), typescript()],
});
