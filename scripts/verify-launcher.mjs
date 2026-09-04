import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const child = spawn(process.execPath, ['scripts/local.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ERP_LAUNCHER_CHECK: 'true' } });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', x => { output += x; });
const exit = new Promise(resolve => child.on('exit', resolve));
const timeout = setTimeout(() => { console.error('Launcher exceeded three minutes.'); child.kill(); process.exitCode = 1; }, 180000);
const code = await exit; clearTimeout(timeout);
const safe = output.replace(/Password: .*/g, 'Password: [redacted]');
if (code !== 0) { console.error(safe); process.exit(1); }
assert.match(output, /Launcher HTTP checks passed/);
console.log('Windows launcher: PostgreSQL startup, migrations, demo seed, build, sign-in and dashboard HTTP checks passed.');
