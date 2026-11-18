const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {fixture} = require('./helpers/mockServices');
const NOW = '2026-11-18T15:00:00.000Z';
const cutoff = Date.parse(NOW) - 30 * 86400000;
function services() {
  const f = fixture({now:NOW});
  const rows = [
    {id:1,event_at:new Date(cutoff-1).toISOString(),done_at:null},
    {id:2,event_at:new Date(cutoff-1).toISOString(),done_at:NOW},
    {id:3,event_at:new Date(cutoff-1).toISOString(),recurring_id:10},
    {id:4,event_at:new Date(cutoff).toISOString()},
    {id:5,event_at:'2026-12-01T00:00:00.000Z',created_at:'2025-01-01T00:00:00.000Z'},
    {id:6,event_at:new Date(cutoff+1).toISOString(),created_at:'2025-01-01T00:00:00.000Z'},
    {id:7,event_at:'2099-01-01T00:00:00Z',recurring_id:10},
  ].map(e=>({chat_id:1,reminded:true,reminded2:true,...e}));
  f.events.push(...rows);
  return f;
}
test('retention uses strict event_at cutoff; completed, one-off and old series instances are removed', async () => {
  const f = services();
  const templates = [{id:10,title:'Действующая серия'}, {id:11,title:'Другая серия'}];
  f.templates.push(...templates);
  assert.equal(await f.load('lib/eventCleanup.js').cleanupOldEvents(),3);
  assert.deepEqual(f.events.map(e=>e.id),[4,5,6,7]);
  assert.deepEqual(f.templates,templates);
  assert.equal(f.queries.length,1);
  assert.equal(f.queries[0].sql, "DELETE FROM events WHERE event_at < now() - interval '30 days'");
});

// Exercise the real cron around isolated substitute services, never a live endpoint.
function cron({cleanupFailure = false, deliveryFailure = false, secret = 'test-cron'} = {}) {
  const calls = [];
  const module = {exports:{}};
  const source = fs.readFileSync('pages/api/cron/reminders.js','utf8').replace('export default async function handler','module.exports = async function handler');
  const mocks = {
    '../../../lib/eventCleanup': {cleanupOldEvents: async () => {calls.push('cleanup'); if (cleanupFailure) throw new Error('private-database-address'); return 3;}},
    '../../../lib/db': {query: async sql => {calls.push('query'); if (deliveryFailure) throw new Error('delivery failed'); return {rows:[]};}},
    '../../../lib/telegram': {}, '../../../lib/time': {}, '../../../lib/settings': {}, '../../../lib/context': {},
    '../../../lib/handlers/reminderButtons': {}, '../../../lib/dayBefore': {sendDayBeforeReminders:async()=>0},
    '../../../lib/reminderDelivery': {}, '../../../lib/reminderSettings': {},
  };
  const logs=[];
  vm.runInNewContext(source,{module,require:name=>{assert.ok(mocks[name],name);return mocks[name];},process:{env:{CRON_SECRET:secret}},console:{error:(...args)=>logs.push(args)}});
  return {calls,logs,run:async(auth='Bearer test-cron')=>{
    let status,body;
    await module.exports({headers:{authorization:auth}}, {status(n){status=n;return this;},json(v){body=v;}});
    return {status,body};
  }};
}
test('cleanup runs on any cron invocation, before delivery; result reports deleted count', async()=>{
  const f=cron();const r=await f.run();
  assert.equal(r.status,200);assert.equal(r.body.cleaned,3);assert.equal(r.body.cleanupFailed,false);
  assert.equal(f.calls[0],'cleanup');
});
test('unauthorized invocations cannot delete anything',async()=>{
  const f=cron();const r=await f.run('Bearer wrong');assert.equal(r.status,401);assert.deepEqual(f.calls,[]);
});
test('cleanup failure is visible, does not block delivery and is retried next invocation',async()=>{
  const f=cron({cleanupFailure:true});
  for(let i=0;i<2;i++) {const r=await f.run();assert.equal(r.status,200);assert.equal(r.body.cleaned,0);assert.equal(r.body.cleanupFailed,true);}
  assert.equal(f.calls.filter(c=>c==='cleanup').length,2);
  assert.ok(f.calls.includes('query'));
  assert.doesNotMatch(JSON.stringify(f.logs),/private-database-address/);
});
test('delivery failure cannot skip cleanup',async()=>{
  const f=cron({deliveryFailure:true});const r=await f.run();assert.equal(r.status,500);assert.equal(f.calls[0],'cleanup');
});

test('missing cron secret fails closed before cleanup', async()=>{const f=cron({secret:null});const r=await f.run('Bearer undefined');assert.equal(r.status,401);assert.deepEqual(f.calls,[]);});
