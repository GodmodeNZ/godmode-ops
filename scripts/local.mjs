import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { config } from 'dotenv';
import EmbeddedPostgres from 'embedded-postgres';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
mkdirSync('.data', { recursive: true });
if (!existsSync('.env')) {
  const password = randomBytes(18).toString('base64url'), databasePassword = randomBytes(24).toString('hex');
  writeFileSync('.env', `DATABASE_URL="postgresql://godmode:${databasePassword}@127.0.0.1:55433/godmode_ops_test?schema=public"\nLOCAL_POSTGRES=true\nLOCAL_DB_PASSWORD=${databasePassword}\nADMIN_EMAIL=admin@godmode.local\nADMIN_PASSWORD=${password}\nERP_TEST_MODE=true\nAPI_PORT=4000\nWEB_ORIGIN=http://localhost:4000\nCOOKIE_SECURE=false\n`, { mode: 0o600 });
  writeFileSync('.data/test-login.txt', `Godmode Ops test environment\nURL: http://localhost:4000\nEmail: admin@godmode.local\nPassword: ${password}\n`, { mode: 0o600 });
}
config();
let pg;
const run = (command, args) => { const r = spawnSync(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' && command === 'npm' }); if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`); };
try {
  if (process.env.LOCAL_POSTGRES === 'true') {
    if (process.platform !== 'win32' && process.getuid?.() === 0) throw new Error('For root-only Linux environments use Docker Compose. PostgreSQL must run as an ordinary OS user.');
    pg = new EmbeddedPostgres({ databaseDir: resolve('.data/postgres'), user: 'godmode', password: process.env.LOCAL_DB_PASSWORD, port: 55433, persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: console.error });
    const fresh = !existsSync('.data/postgres/PG_VERSION');
    if (fresh) await pg.initialise();
    await pg.start(); if (fresh) await pg.createDatabase('godmode_ops_test');
  }
  run(process.execPath, ['node_modules/prisma/build/index.js', 'generate']);
  run(process.execPath, ['scripts/migrate.mjs']);
  if (process.env.ERP_TEST_MODE === 'true') run(process.execPath, ['--import', 'tsx', 'prisma/seed.ts']);
  run('npm', ['run', 'build']);
  const server = spawn(process.execPath, ['apps/api/dist/server.js'], { stdio: 'inherit', env: process.env });
  console.log('\nGodmode Ops: http://localhost:' + (process.env.API_PORT ?? 4000));
  if (existsSync('.data/test-login.txt')) console.log(readFileSync('.data/test-login.txt', 'utf8'));
  console.log('Keep this window open. Your test data is saved between sessions.');
  const cleanup = async () => { server.kill('SIGTERM'); if (pg) await pg.stop(); };
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup);
  server.on('exit', async code => { if (pg) await pg.stop(); process.exit(code ?? 0); });
} catch (e) { console.error(e.message); if (pg) await pg.stop(); process.exitCode = 1; }
