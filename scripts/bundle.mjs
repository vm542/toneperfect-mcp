// Bundle the stdio server into one dependency-free file for the MCPB (Claude Desktop / Smithery) bundle.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'mcpb/server/index.cjs',
  legalComments: 'none',
  logLevel: 'info',
});
