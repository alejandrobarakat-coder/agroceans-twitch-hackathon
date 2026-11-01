'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTwitchUserOAuth } = require('../src/twitch-user-oauth');
const origin = 'https://twitch.theagrostore.com';
const prefix = '/auth/twitch/user/';
function fixture(options = {}) {
  let time = 1000, calls = [];
  const handle = createTwitchUserOAuth({ clientId: 'client', clientSecret: 'secret', broadcasterId: '999', now: () => time,
    fetchImpl: async (url, opts) => { calls.push([url, opts]); return Response.json(url.endsWith('/token') ? { access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600, scope: ['user:write:chat'], token_type: 'bearer' } : { client_id: 'client', user_id: '123', login: 'tester', expires_in: 3600, scopes: ['user:write:chat'] }); }, ...options });
  async function req(route, cookie = '', method = 'GET', extra = {}, body = '') {
    const res = { headers: {}, setHeader(k,v) { this.headers[k] = v; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
    const handled = await handle(Object.assign(require('node:stream').Readable.from([Buffer.from(body)]), { method, headers: { cookie, ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...extra } }), res, new URL(route, origin));
    return { ...res, handled };
  }
  async function begin() {
    const device = await req(prefix + 'request', '', 'POST');
    assert.equal(device.status, 200);
    const appCookie = device.headers['Set-Cookie'].split(';')[0];
    const startUrl = JSON.parse(device.body).authorizeUrl;
    const start = await req(startUrl);
    const state = new URL(start.headers.Location).searchParams.get('state');
    return { appCookie, browserCookie: start.headers['Set-Cookie'].split(';')[0], state, startUrl, start };
  }
  return { req, begin, calls, expire: () => { time += 1000000; } };
}
test('operator callback and unrelated routes remain untouched', async () => {
  const f = fixture(); assert.equal((await f.req('/auth/twitch/callback?state=operator')).handled, false);
  assert.equal((await f.req('/health')).handled, false);
});
test('paired identity is only visible to original device; automatic connection; no tokens disclosed', async () => {
  const f = fixture(), a = await f.begin();
  assert.equal(new URL(a.start.headers.Location).searchParams.get('redirect_uri'), origin + '/auth/twitch/callback');
  assert.equal(new URL(a.start.headers.Location).searchParams.get('scope'), 'user:write:chat');
  assert.match(a.appCookie, /__Host-/);
  const result = await f.req('/auth/twitch/callback?state=' + a.state + '&code=private-code', a.browserCookie);
  assert.equal(result.status, 200); assert.match(result.body, /agroceans:\/\/live/);
  assert.equal(JSON.parse((await f.req(prefix + 'status')).body).status, 'disconnected');
  const status = await f.req(prefix + 'status', a.appCookie);
  assert.deepEqual(JSON.parse(status.body), { status: 'connected', identity: { id: '123', login: 'tester' }, chatReady: true });
  assert.equal((await f.req(prefix + 'confirm', a.appCookie, 'POST')).status, 409);
  assert.doesNotMatch(JSON.stringify([result, status]), /private-token|private-code|secret/);
  await f.req(prefix + 'logout', a.appCookie, 'POST');
  assert.equal(JSON.parse((await f.req(prefix + 'status', a.appCookie)).body).status, 'disconnected');
});
test('callback requires matching browser, rejects duplicates and replay, and exchanges once', async () => {
  const f = fixture(), a = await f.begin(), b = await f.begin();
  const cb = '/auth/twitch/callback?state=' + a.state + '&code=x';
  assert.equal((await f.req(cb, b.browserCookie)).status, 400);
  assert.equal((await f.req(cb + '&state=other', a.browserCookie)).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.req(cb, a.browserCookie)).status, 200);
  assert.equal((await f.req(cb, a.browserCookie)).status, 400);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.req(a.startUrl)).status, 400);
});
test('mutation requires exact origin, JSON and correct HTTP method', async () => {
  const f = fixture();
  for (const extra of [{origin: ''}, {origin:'https://evil.test'}, {'content-type':'text/plain'}]) assert.equal((await f.req(prefix+'request','','POST',extra)).status,403);
  assert.equal((await f.req(prefix+'request')).status,405);
  assert.equal((await f.req(prefix+'confirm','','POST')).status,409);
});
test('expiry and provider client mismatch fail closed', async () => {
  const f = fixture(), a = await f.begin(); f.expire();
  assert.equal((await f.req('/auth/twitch/callback?state='+a.state+'&code=x',a.browserCookie)).status,400);
  const g=fixture({fetchImpl:async url=>Response.json(url.endsWith('/token')?{access_token:'private-token',token_type:'bearer'}:{client_id:'wrong',user_id:'123',login:'tester',expires_in:3600})});
  const b=await g.begin();
  assert.equal((await g.req('/auth/twitch/callback?state='+b.state+'&code=x',b.browserCookie)).status,400);
  assert.equal(JSON.parse((await g.req(prefix+'status',b.appCookie)).body).status,'failed');
});
test('denial consumes state and does not call provider; capacity is bounded',async()=>{
  const f=fixture(),a=await f.begin();
  assert.equal((await f.req('/auth/twitch/callback?state='+a.state+'&error=access_denied',a.browserCookie)).status,400);
  assert.equal(f.calls.length,0);
  const g=fixture({capacity:1});await g.begin();
  assert.equal((await g.req(prefix+'request','','POST')).status,429);
});

test('identity and private chat authorization survive restart; logout removes both', async () => {
  const stored = new Map();
  const storage = { prepare() {}, read(name, fallback) { return stored.has(name) ? structuredClone(stored.get(name)) : fallback; },
    transaction(fn) { return fn(); }, write(name, value) { stored.set(name, structuredClone(value)); } };
  const f = fixture({ storage }), a = await f.begin();
  assert.equal((await f.req('/auth/twitch/callback?state=' + a.state + '&code=x', a.browserCookie)).status, 200);
  assert.doesNotMatch(JSON.stringify(stored.get('identities.json')), /private-token|private-code|secret|refresh_token|access_token/);
  const g = fixture({ storage });
  assert.equal(JSON.parse((await g.req(prefix + 'status', a.appCookie)).body).status, 'connected');
  await g.req(prefix + 'logout', a.appCookie, 'POST');
  const h = fixture({ storage });
  assert.equal(JSON.parse((await h.req(prefix + 'status', a.appCookie)).body).status, 'disconnected');
});
test('unavailable or malformed identity storage fails closed', async () => {
  const storage = { prepare() { throw Error('private-secret'); } };
  const f = fixture({ storage });
  const result = await f.req(prefix + 'status');
  assert.equal(result.status, 503); assert.doesNotMatch(result.body, /private-secret/);
});
test('real private storage persists identity, expires sessions, and restricts permissions', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { TwitchStorage } = require('../src/twitch-storage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-user-'));
  const directory = path.join(root, 'identities');
  try {
    const f = fixture({ storage: new TwitchStorage(directory) }), a = await f.begin();
    assert.equal((await f.req('/auth/twitch/callback?state=' + a.state + '&code=x', a.browserCookie)).status, 200);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    const file = path.join(directory, 'identities.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(directory, 'authorizations.json')).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-token|access_token|refresh_token/);
    const g = fixture({ storage: new TwitchStorage(directory) });
    assert.equal(JSON.parse((await g.req(prefix + 'status', a.appCookie)).body).status, 'connected');
    for (let i=0; i<606; i++) g.expire();
    assert.equal(JSON.parse((await g.req(prefix + 'status', a.appCookie)).body).status, 'disconnected');
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});
async function authorized(options = {}) {
  const calls = [];
  const token = {access_token:'private-token',refresh_token:'private-refresh',expires_in:3600,token_type:'bearer',scope:['user:write:chat']};
  const identity = {client_id:'client',user_id:'123',login:'tester',expires_in:3600,scopes:['user:write:chat']};
  const f = fixture({fetchImpl:async(url, opts)=>{
    calls.push([url,opts]);
    if (options.fetchImpl) return options.fetchImpl(url, opts, calls);
    return Response.json(url.endsWith('/token')?token:url.endsWith('/validate')?identity:{data:[{is_sent:true,message_id:'message-1'}]});
  },...options.factory});
  const a=await f.begin();
  assert.equal((await f.req('/auth/twitch/callback?state='+a.state+'&code=x',a.browserCookie)).status,200);
  return {f,a,calls,token,identity};
}
test('chat sends with validated user identity and pinned channel, never with client-supplied sender',async()=>{
  const {f,a,calls}=await authorized();
  const response=await f.req(prefix+'send',a.appCookie,'POST',{},JSON.stringify({message:' Hello '}));
  assert.equal(response.status,200);
  const sent=calls.find(([url])=>url.endsWith('/chat/messages'));
  assert.deepEqual(JSON.parse(sent[1].body),{broadcaster_id:'999',sender_id:'123',message:'Hello'});
  assert.equal(sent[1].headers.Authorization,'Bearer private-token');
  assert.doesNotMatch(response.body,/private-token|private-refresh/);
  assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{},JSON.stringify({message:'again'}))).status,429);
});
test('chat rejects unauthenticated, cross-origin, malformed and oversized requests without sending',async()=>{
  const {f,a,calls}=await authorized();
  assert.equal((await f.req(prefix+'send','','POST',{},'{"message":"Hi"}')).status,401);
  assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{origin:'https://evil.test'},'{"message":"Hi"}')).status,403);
  for (const body of ['bad','{"message":" "}',JSON.stringify({message:'x'.repeat(501)}),'{"message":"hi","sender_id":"evil"}']) assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{},body)).status,400);
  assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{},'x'.repeat(5000))).status,413);
  assert.equal(calls.filter(([url])=>url.endsWith('/chat/messages')).length,0);
});
test('ambiguous message delivery is never retried or reported as success',async()=>{
  let sends=0;
  const {f,a}=await authorized({fetchImpl:async(url)=>{
    if(url.endsWith('/chat/messages')) {sends++;throw Error('private-token');}
    return Response.json(url.endsWith('/token')?{access_token:'private-token',refresh_token:'private-refresh',token_type:'bearer',expires_in:3600,scope:['user:write:chat']}:{client_id:'client',user_id:'123',login:'tester',expires_in:3600,scopes:['user:write:chat']});
  }});
  const result=await f.req(prefix+'send',a.appCookie,'POST',{},'{"message":"Hi"}');
  assert.equal(result.status,502);assert.equal(sends,1);assert.doesNotMatch(result.body,/private-token/);
});
test('expired access refreshes privately before validation and send',async()=>{
  let refreshes=0;
  const {f,a}=await authorized({fetchImpl:async(url,opts)=>{
    if(url.endsWith('/token')) {
      if(opts.body.get('grant_type')==='refresh_token') refreshes++;
      return Response.json({access_token:'private-token',refresh_token:'private-refresh',token_type:'bearer',expires_in:3600,scope:['user:write:chat']});
    }
    return Response.json(url.endsWith('/validate')?{client_id:'client',user_id:'123',login:'tester',expires_in:3600,scopes:['user:write:chat']}:{data:[{is_sent:true,message_id:'message-1'}]});
  }});
  for(let i=0;i<4;i++) f.expire();
  assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{},'{"message":"Hi"}')).status,200);
  assert.equal(refreshes,1);
});
test('Twitch moderation drop is not reported as sent',async()=>{
  const {f,a}=await authorized({fetchImpl:async url=>Response.json(url.endsWith('/token')?{access_token:'private-token',refresh_token:'private-refresh',token_type:'bearer',expires_in:3600,scope:['user:write:chat']}:url.endsWith('/validate')?{client_id:'client',user_id:'123',login:'tester',expires_in:3600,scopes:['user:write:chat']}:{data:[{is_sent:false,message_id:'',drop_reason:{code:'blocked'}}]})});
  assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{},'{"message":"Hi"}')).status,409);
});
test('validation of a different sender blocks the chat POST',async()=>{
  let validations=0,sends=0;
  const {f,a}=await authorized({fetchImpl:async url=>{
    if(url.endsWith('/token')) return Response.json({access_token:'private-token',refresh_token:'private-refresh',token_type:'bearer',expires_in:3600,scope:['user:write:chat']});
    if(url.endsWith('/validate')) return Response.json({client_id:'client',user_id:++validations===1?'123':'456',login:'tester',expires_in:3600,scopes:['user:write:chat']});
    sends++;return Response.json({data:[{is_sent:true,message_id:'bad'}]});
  }});
  assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{},'{"message":"Hi"}')).status,502);
  assert.equal(sends,0);
});
test('missing write-chat scope cannot produce an authorized composer session',async()=>{
  const f=fixture({fetchImpl:async url=>Response.json(url.endsWith('/token')?{access_token:'private-token',refresh_token:'private-refresh',token_type:'bearer',expires_in:3600,scope:[]}:{client_id:'client',user_id:'123',login:'tester',expires_in:3600,scopes:[]})});
  const a=await f.begin();
  assert.equal((await f.req('/auth/twitch/callback?state='+a.state+'&code=x',a.browserCookie)).status,400);
  assert.equal(JSON.parse((await f.req(prefix+'status',a.appCookie)).body).chatReady,false);
});

test('message history contains sent messages without credentials or another input session',async()=>{
  const {f,a}=await authorized();
  assert.equal((await f.req(prefix+'send',a.appCookie,'POST',{},'{"message":"Hello"}')).status,200);
  const result=await f.req(prefix+'messages');
  assert.equal(result.status,200);
  const rows=JSON.parse(result.body).messages;
  assert.equal(rows.length,1);assert.equal(rows[0].login,'tester');assert.equal(rows[0].text,'Hello');
  assert.doesNotMatch(result.body,/private-token|private-refresh|access_token/);
  f.expire();assert.equal(JSON.parse((await f.req(prefix+'messages')).body).messages.length,0);
});
test('chat feed bounds and deduplicates public messages',async()=>{
  const handle=createTwitchUserOAuth({clientId:'client',clientSecret:'secret'});
  for(let i=0;i<150;i++) handle.observeChat({id:'id-'+i,login:'viewer',text:'<b>'+i+'</b>'});
  handle.observeChat({id:'id-149',login:'viewer',text:'duplicate'});
  handle.observeChat({id:'invalid',login:'<script>',text:'bad'});
  const res={setHeader(){},writeHead(status){this.status=status;},end(body){this.body=body;}};
  await handle({method:'GET',headers:{}},res,new URL(prefix+'messages',origin));
  const rows=JSON.parse(res.body).messages;
  assert.equal(rows.length,100);assert.equal(rows[0].id,'id-50');assert.equal(rows.at(-1).text,'<b>149</b>');
});
