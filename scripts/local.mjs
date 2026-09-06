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
let pg, pgCtl, server, databaseStarted = false, cleanupPromise;
const run = (command, args) => { const r = spawnSync(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' && command === 'npm' }); if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`); };
const cleanup = () => cleanupPromise ??= (async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM'); await exited;
  }
  if (databaseStarted) {
    databaseStarted = false;
    if (pgCtl) run(pgCtl, ['stop', '-D', resolve('.data/postgres'), '-m', 'fast', '-w', '-t', '30']);
    else await pg.stop();
  }
})();
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
try {
  if (process.env.LOCAL_POSTGRES === 'true') {
    if (process.platform !== 'win32' && process.getuid?.() === 0) throw new Error('For root-only Linux environments use Docker Compose. PostgreSQL must run as an ordinary OS user.');
    pg = new EmbeddedPostgres({ databaseDir: resolve('.data/postgres'), user: 'godmode', password: process.env.LOCAL_DB_PASSWORD, port: 55433, persistent: true, initdbFlags: ['--encoding=UTF8'], postgresFlags: ['-h', '127.0.0.1'], onLog: console.log, onError: console.error });
    const fresh = !existsSync('.data/postgres/PG_VERSION');
    if (fresh) await pg.initialise();
    if (process.platform === 'win32') {
      // pg_ctl creates a restricted Windows token; postgres.exe itself rejects
      // an elevated parent. It also provides a clean, checkpointed shutdown.
      ({ pg_ctl: pgCtl } = await import('@embedded-postgres/windows-x64'));
      try { run(pgCtl, ['start', '-D', resolve('.data/postgres'), '-l', resolve('.data/postgres.log'), '-o', '-h 127.0.0.1 -p 55433', '-w', '-t', '30']); }
      catch (error) { if (existsSync('.data/postgres.log')) console.error(readFileSync('.data/postgres.log', 'utf8')); throw error; }
    } else await pg.start();
    databaseStarted = true;
    const client = pg.getPgClient('postgres', '127.0.0.1');
    try {
      await client.connect();
      if (!(await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['godmode_ops_test'])).rowCount) await client.query('CREATE DATABASE godmode_ops_test');
    } finally { await client.end(); }
  }
  run(process.execPath, ['node_modules/prisma/build/index.js', 'generate']);
  run(process.execPath, ['scripts/migrate.mjs']);
  if (process.env.ERP_TEST_MODE === 'true') run(process.execPath, ['--import', 'tsx', 'prisma/seed.ts']);
  run('npm', ['run', 'build']);
  server = spawn(process.execPath, ['apps/api/dist/server.js'], { stdio: 'inherit', env: process.env });
  if (process.env.ERP_LAUNCHER_CHECK === 'true') {
    const origin = 'http://localhost:' + (process.env.API_PORT ?? 4000);
    let ready = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 500)); }
    if (!ready) { server.kill(); throw new Error('Server health check failed'); }
    const index = await fetch(origin); if (!index.ok || !(await index.text()).includes('Godmode Ops')) throw new Error('Dashboard was not served');
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
    if (!login.ok) throw new Error('Generated test administrator cannot sign in');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const builds = await fetch(origin + '/api/builds', { headers: { cookie } });
    if (!builds.ok || (await builds.json()).length < 3) throw new Error('Demo builds are missing');
    console.log('Launcher HTTP checks passed'); await cleanup(); process.exit(0);
  }
  console.log('\nGodmode Ops: http://localhost:' + (process.env.API_PORT ?? 4000));
  if (existsSync('.data/test-login.txt')) console.log(readFileSync('.data/test-login.txt', 'utf8'));
  console.log('Keep this window open. Your test data is saved between sessions.');
  server.on('exit', async code => { await cleanup(); process.exit(code ?? 0); });
} catch (e) { console.error(e instanceof Error ? e.message : 'Database startup failed; see the PostgreSQL output above.'); await cleanup(); process.exitCode = 1; }
