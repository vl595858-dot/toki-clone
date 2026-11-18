const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('pages/api/setup-webhook.js', 'utf8').replace('export default async function handler', 'module.exports = async function handler');
const configured = { SETUP_KEY: 'test-admin', TELEGRAM_WEBHOOK_SECRET: 'test-hook', APP_URL: 'https://trusted.example' };
async function request(req = {}, env = configured, result = true) {
  const calls = [], logs = [], module = {exports: {}};
  vm.runInNewContext(source, {module, Buffer, URL, process: {env}, console: {error: (...args) => logs.push(args)},
    require: name => name === 'crypto' ? crypto : {setWebhook: async url => {calls.push(url); if (result instanceof Error) throw result; return result;}}});
  let status, body;
  const headers = {};
  await module.exports({method: 'POST', query: {}, headers: {authorization: 'Bearer test-admin', host: 'attacker.example', 'x-forwarded-host': 'attacker.example'}, ...req},
    {setHeader(k,v) {headers[k] = v;}, status(code) {status = code; return this;}, json(data) {body = data;}});
  return {calls, logs, status, body, headers};
}
test('setup only accepts authenticated POST; old URL-key requests and unset key fail closed', async () => {
  for (const req of [{method:'GET', query:{key:'test-admin'}}, {headers:{}}, {headers:{authorization:'Bearer wrong'}}, {headers:{authorization:['Bearer test-admin']}}, {query:{key:'test-admin'}, headers:{}}]) {
    const r = await request(req);
    assert.equal(r.calls.length, 0);
    assert.ok([403,405].includes(r.status));
    assert.equal(r.headers['Cache-Control'], 'no-store');
  }
  const r = await request({}, {...configured, SETUP_KEY: undefined});
  assert.equal(r.status,503); assert.equal(r.calls.length,0);
});
test('trusted origin is used regardless of host headers and response contains no webhook URL or Telegram payload', async () => {
  const r = await request();
  assert.deepEqual(r.calls, ['https://trusted.example/api/telegram/test-hook']);
  assert.equal(r.status,200);
  assert.equal(JSON.stringify(r.body), '{"ok":true}');
  const fallback = await request({}, {...configured, APP_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL:'production.example'});
  assert.deepEqual(fallback.calls, ['https://production.example/api/telegram/test-hook']);
});
test('missing and invalid trusted configuration never calls Telegram', async () => {
  for (const origin of [undefined, 'http://unsafe.example', 'https://user:pass@host.example', 'https://trusted.example/path', 'https://trusted.example/?query', 'https://trusted.example/#hash', 'not a URL']) {
    const r = await request({}, {...configured, APP_URL:origin});
    assert.equal(r.status,503); assert.equal(r.calls.length,0);
  }
  const r = await request({}, {...configured, TELEGRAM_WEBHOOK_SECRET:undefined});
  assert.equal(r.status,503); assert.equal(r.calls.length,0);
});
test('Telegram rejection and network errors are sanitized in responses and logs', async () => {
  for (const result of [false, new Error('https://secret.example/api/telegram/test-hook?token=test-admin')]) {
    const r = await request({}, configured, result);
    assert.equal(r.status,502);
    assert.doesNotMatch(JSON.stringify({body:r.body, logs:r.logs}), /test-hook|test-admin|secret.example/);
  }
});
test('setWebhook uses POST body and timeout, validates Telegram acknowledgement', async () => {
  const src = fs.readFileSync('lib/telegram.js','utf8');
  for (const response of [{ok:true,status:200,json:async()=>({ok:true, result:'never-return-this'})}, {ok:true,status:200,json:async()=>({ok:false})}, {ok:false,status:500,json:async()=>({ok:true})}]) {
    const module = {exports:{}};
    vm.runInNewContext(src, {module, process:{env:{TELEGRAM_BOT_TOKEN:'test-bot'}}, AbortSignal, fetch:async(url, opts)=>{
      assert.equal(url,'https://api.telegram.org/bottest-bot/setWebhook');
      assert.equal(opts.method,'POST'); assert.ok(opts.signal);
      assert.equal(JSON.parse(opts.body).url,'https://trusted.example/api/telegram/test-hook');
      return response;
    }});
    assert.equal(await module.exports.setWebhook('https://trusted.example/api/telegram/test-hook'), response.ok && response.status===200 && (await response.json()).ok===true);
  }
});
