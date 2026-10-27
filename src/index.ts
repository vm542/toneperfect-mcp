#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; log to stderr only.
  console.error('toneperfect-mcp running on stdio');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
