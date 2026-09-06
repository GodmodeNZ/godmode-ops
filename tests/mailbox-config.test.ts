import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeMailboxConfig} from '../apps/api/src/mailbox.js';
const prior={provider:'GMAIL',clientId:'test-id',clientSecret:'test-secret',refreshToken:'test-refresh',connectedAt:'2026-09-06',autoImport:true,cursor:'old-page',folder:'Invoices',since:'2026-09-06',senders:[]};
test('mailbox edits retain credentials and consent but pause scheduling and reset pagination',()=>{
 const next=mergeMailboxConfig(prior,{provider:'GMAIL',clientId:'',clientSecret:'',folder:'Invoices',since:'2026-09-02',senders:['invoices@example.com']});
 assert.equal(next.refreshToken,prior.refreshToken);assert.equal(next.clientSecret,prior.clientSecret);assert.equal(next.connectedAt,prior.connectedAt);assert.equal(next.since,'2026-09-02');assert.equal(next.autoImport,false);assert.equal(next.cursor,null);
});
test('different OAuth client cannot inherit an old authorization',()=>{
 const next=mergeMailboxConfig(prior,{provider:'GMAIL',clientId:'new-id',clientSecret:'new-secret',folder:'Invoices',since:'2026-09-06',senders:[]});
 assert.equal(next.refreshToken,undefined);assert.equal(next.connectedAt,undefined);
 assert.throws(()=>mergeMailboxConfig(prior,{provider:'MICROSOFT',clientId:'',clientSecret:''}));
 assert.throws(()=>mergeMailboxConfig(null,{provider:'GMAIL',clientId:'',clientSecret:''}));
});
