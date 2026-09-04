import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
mkdirSync('.data/backups', { recursive: true });
const path = `.data/backups/godmode-ops-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
const command = spawn('docker', ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', 'godmode', '-d', 'godmode_ops', '--format=custom'], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const exit = new Promise((resolve, reject) => { command.on('error', reject); command.on('close', code => code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}`))); });
  await Promise.all([pipeline(command.stdout, createWriteStream(path, { mode: 0o600 })), exit]);
  console.log(`Backup saved: ${path}`);
} catch (e) { try { unlinkSync(path); } catch {} console.error(e.message); process.exitCode = 1; }
