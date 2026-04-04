import { defineConfig } from 'tsup';

export default defineConfig([
  // ── Bundle principal: agnóstico (navegador + Node.js) ──────────────────────
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  // ── Bundle SvelteKit: servidor Node.js exclusivamente ─────────────────────
  {
    entry: { sveltekit: 'src/sveltekit/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    platform: 'node',
    // No bundlear las dependencias pesadas: se resuelven en runtime
    external: ['@mistralai/mistralai', 'ws'],
  },
]);
