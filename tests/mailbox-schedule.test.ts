import test from 'node:test';
import assert from 'node:assert/strict';
import { mailboxScheduleDue } from '../apps/api/src/mailbox.js';
test('mailbox schedule resumes from persisted status, backs off failures and continues batches',()=>{
 const now=Date.now();
 assert.equal(mailboxScheduleDue(null,now),false);
 assert.equal(mailboxScheduleDue({connected:true,autoImport:false},now),false);
 assert.equal(mailboxScheduleDue({connected:false,autoImport:true},now),false);
 assert.equal(mailboxScheduleDue({connected:true,autoImport:true},now),true);
 const c={connected:true,autoImport:true,lastAutoAttempt:new Date(now-60000).toISOString()};
 assert.equal(mailboxScheduleDue(c,now),false);
 assert.equal(mailboxScheduleDue(c,now+840000),true);
 assert.equal(mailboxScheduleDue({...c,lastSync:{more:true,errors:[]}},now),true);
 assert.equal(mailboxScheduleDue({...c,lastSync:{more:true,errors:['retry me']}},now),false);
 assert.equal(mailboxScheduleDue({...c,lastSync:{more:true,errors:[]},lastAutoError:'Reconnect'},now),false);
});
