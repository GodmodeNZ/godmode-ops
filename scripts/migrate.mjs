import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
const db = new PrismaClient();
const args = process.argv.slice(2);
try {
  const tables = await db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`;
  const names = new Set(tables.map(t => t.table_name));
  if (names.has('InventoryTransaction') && !names.has('_prisma_migrations')) {
    if (!args.includes('--baseline-existing')) throw new Error('Existing M1–M5 database detected. Back it up, then run npm run db:deploy -- --baseline-existing. No data was changed.');
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'resolve', '--applied', '202609040001_baseline'], { stdio: 'inherit', env: process.env });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} finally { await db.$disconnect(); }
const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
