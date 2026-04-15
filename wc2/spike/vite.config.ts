import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    nodePolyfills({
      // Buffer, process, crypto — all used by the Octez.connect SDK
      include: ['buffer', 'crypto', 'process', 'stream', 'util'],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
})
