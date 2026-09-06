import {spawnSync} from 'node:child_process';
const url=new URL(process.env.DATABASE_URL??'postgresql://invalid/');
if(!/^\/(godmode_fx_isolated_test_\d+|godmode_ops_ci_test)$/.test(url.pathname))throw new Error('Tests require a disposable godmode_fx_isolated_test_<timestamp> or godmode_ops_ci_test database. The local ERP database is never a test target.');
const files=process.argv.slice(2);
const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1',...(files.length?files:['tests/*.test.ts'])],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
