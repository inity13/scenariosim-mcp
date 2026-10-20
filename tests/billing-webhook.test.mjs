import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../worker-src/billing.mjs';
import worker from '../worker-src/index.mjs';

const APP = 'scenariosim';
const BINDING = 'SCENARIOSIM_KV';
function fixture(change = {}) {
  const store = new Map(), requests = [];
  const subscription = { id: 'sub_fixture', customer: 'cus_fixture', status: 'active', items: {data:[{price:{id:'price_starter'}}]} };
  const session = { id:'cs_test_fixture', status:'complete', mode:'subscription', payment_status:'paid', metadata:{app:APP}, customer:'cus_fixture', line_items:{data:[{price:{id:'price_starter'}}]}, subscription, ...change };
  const kv = {get:async(k,t)=>{const v=store.get(k)??null;return t==='json'&&v?JSON.parse(v):v;},put:async(k,v)=>{store.set(k,v);}};
  const env={STRIPE_SECRET_KEY:'offline-only',STRIPE_WEBHOOK_SECRET:'offline-webhook-secret',PRICE_STARTER:'price_starter',PRICE_PRO:'price_pro',[BINDING]:kv};
  const fetch=async(url,options)=>{
    assert.equal(options.method,'GET','fixtures must never create Stripe objects');
    requests.push(String(url));
    assert.ok(String(url).startsWith('https://api.stripe.com/v1/'));
    if(String(url).includes('/subscriptions/'))return Response.json(subscription);
    assert.ok(String(url).includes('/checkout/sessions/cs_test_fixture'));
    return Response.json(session);
  };
  return {store,kv,env,session,subscription,requests,fetch};
}
async function using(f,run){const old=globalThis.fetch;globalThis.fetch=f.fetch;try{return await run();}finally{globalThis.fetch=old;}}
function event(type='checkout.session.completed',extra={}){return {type,data:{object:{id:'cs_test_fixture',metadata:{app:APP},payment_status:'paid',...extra}}};}
function records(f){return [...f.store.keys()].filter(k=>k.startsWith('key:'));}
async function sign(payload,secret,t=Math.floor(Date.now()/1000)){
  const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(`${t}.${payload}`))).toString('hex');
  return `t=${t},v1=${signature}`;
}
async function post(f,e,signature){const payload=JSON.stringify(e);return worker.fetch(new Request('https://fixture.invalid/webhook',{method:'POST',headers:{'stripe-signature':signature??await sign(payload,f.env.STRIPE_WEBHOOK_SECRET)},body:payload}),f.env);}

test('paid signed webhook provisions without browser return; success recovery reuses one key',async()=>{
  const f=fixture();await using(f,async()=>{
    assert.equal((await post(f,event())).status,200);
    const key=f.store.get('session:cs_test_fixture');assert.ok(key);assert.equal(records(f).length,1);
    assert.equal(JSON.parse(f.store.get(`key:${key}`)).customer,'cus_fixture');
    assert.equal((await B.provisionFromSession(f.env,'cs_test_fixture')).key,key);
    assert.equal((await post(f,event())).status,200);assert.equal(records(f).length,1);
  });
});
test('signed delayed-payment success provisions after paid status',async()=>{const f=fixture();await using(f,async()=>{assert.equal((await post(f,event('checkout.session.async_payment_succeeded'))).status,200);assert.equal(records(f).length,1);});});
test('unpaid or other-service events are acknowledged without reads/writes',async()=>{const f=fixture();await using(f,async()=>{await post(f,event(undefined,{payment_status:'unpaid'}));await post(f,event(undefined,{metadata:{app:'unrelated'}}));assert.equal(f.store.size,0);assert.equal(f.requests.length,0);});});
for(const [label,change] of [
 ['fresh unpaid',{payment_status:'unpaid'}],['open checkout',{status:'open'}],['wrong session',{id:'cs_test_other'}],['wrong mode',{mode:'payment'}],['foreign app',{metadata:{app:'unrelated'}}],
 ['foreign checkout price',{line_items:{data:[{price:{id:'foreign'}}]}}],
 ['customer mismatch',{subscription:{id:'sub_fixture',customer:'different',status:'active',items:{data:[{price:{id:'price_starter'}}]}}}],
 ['canceled subscription',{subscription:{id:'sub_fixture',customer:'cus_fixture',status:'canceled',items:{data:[{price:{id:'price_starter'}}]}}}],
 ['foreign subscription price',{subscription:{id:'sub_fixture',customer:'cus_fixture',status:'active',items:{data:[{price:{id:'foreign'}}]}}}],
 ['different configured subscription price',{subscription:{id:'sub_fixture',customer:'cus_fixture',status:'active',items:{data:[{price:{id:'price_pro'}}]}}}],
])test(`permanent rejection: ${label}`,async()=>{const f=fixture(change);await using(f,async()=>{await assert.rejects(()=>B.provisionFromSession(f.env,'cs_test_fixture'));assert.equal(records(f).length,0);assert.equal((await post(f,event())).status,200);assert.equal(records(f).length,0);});});
test('missing configured prices never fall back to metadata/default starter',async()=>{const f=fixture();delete f.env.PRICE_STARTER;delete f.env.PRICE_PRO;await using(f,async()=>{await assert.rejects(()=>B.provisionFromSession(f.env,'cs_test_fixture'));assert.equal(f.store.size,0);});});
test('unexpanded subscription is fetched and its ID must match',async()=>{const f=fixture({subscription:'sub_fixture'});await using(f,async()=>{await B.provisionFromSession(f.env,'cs_test_fixture');assert.ok(f.requests.some(u=>u.includes('/subscriptions/sub_fixture')));});const bad=fixture({subscription:'sub_other'});await using(bad,async()=>{await assert.rejects(()=>B.provisionFromSession(bad.env,'cs_test_fixture'));assert.equal(records(bad).length,0);});});
test('cached key cannot bypass current canceled payment authority',async()=>{const f=fixture();await using(f,async()=>{await B.provisionFromSession(f.env,'cs_test_fixture');f.subscription.status='canceled';await assert.rejects(()=>B.provisionFromSession(f.env,'cs_test_fixture'));assert.equal(records(f).length,1);});});
test('same-isolate and independent module instances converge on one key',async()=>{const f=fixture();const second=await import(`../worker-src/billing.mjs?independent=${APP}`);await using(f,async()=>{const values=await Promise.all([B.provisionFromSession(f.env,'cs_test_fixture'),B.provisionFromSession(f.env,'cs_test_fixture'),second.provisionFromSession(f.env,'cs_test_fixture')]);assert.equal(new Set(values.map(v=>v.key)).size,1);assert.equal(records(f).length,1);});});
for(const prefix of ['session:','key:','sub:'])test(`partial KV ${prefix} failure retries without extra key`,async()=>{const f=fixture();let once=true;const put=f.kv.put;f.kv.put=async(k,v)=>{if(once&&k.startsWith(prefix)){once=false;throw Error('offline KV failure');}return put(k,v);};await using(f,async()=>{await assert.rejects(()=>B.provisionFromSession(f.env,'cs_test_fixture'));await B.provisionFromSession(f.env,'cs_test_fixture');assert.equal(records(f).length,1);assert.equal(f.store.get('sub:sub_fixture'),f.store.get('session:cs_test_fixture'));});});
test('subscription deletion racing the first marker never leaves usable access',async()=>{const f=fixture();const put=f.kv.put;let once=true;f.kv.put=async(k,v)=>{if(once&&k.startsWith('session:')){once=false;f.subscription.status='canceled';await B.handleWebhookEvent(f.env,event('customer.subscription.deleted',{id:'sub_fixture',customer:'cus_fixture',status:'canceled'}));}return put(k,v);};await using(f,async()=>{await assert.rejects(()=>B.provisionFromSession(f.env,'cs_test_fixture'));const key=f.store.get('session:cs_test_fixture');const identity=await B.identify(new Request('https://fixture.invalid/mcp',{headers:{'x-api-key':key}}),f.env);assert.equal(identity.active,false);});});
test('late old active event cannot undo terminal deletion',async()=>{const f=fixture();await using(f,async()=>{const {key}=await B.provisionFromSession(f.env,'cs_test_fixture');await B.handleWebhookEvent(f.env,event('customer.subscription.deleted',{id:'sub_fixture',customer:'cus_fixture',status:'canceled'}));f.subscription.status='active';await B.handleWebhookEvent(f.env,event('customer.subscription.updated',{id:'sub_fixture',customer:'cus_fixture',status:'active'}));assert.equal(JSON.parse(f.store.get(`key:${key}`)).status,'inactive');});});
test('upstream failure and KV failure request a signed webhook retry',async()=>{const f=fixture();f.fetch=async()=>Response.json({error:{message:'offline unavailable'}},{status:503});await using(f,async()=>{assert.equal((await post(f,event())).status,500);assert.equal(f.store.size,0);});const storage=fixture();storage.kv.put=async()=>{throw Error('offline KV');};await using(storage,async()=>assert.equal((await post(storage,event())).status,500));});
test('invalid signature is rejected before any Stripe/KV access',async()=>{const f=fixture();await using(f,async()=>{assert.equal((await post(f,event(),'t=1,v1=bad')).status,400);assert.equal(f.store.size,0);assert.equal(f.requests.length,0);});});
test('timestamp bounds, body integrity, duplicate timestamp and multiple v1 signatures',async()=>{
  const f=fixture(),payload='{"fixture":true}',now=Math.floor(Date.now()/1000);
  assert.equal(await B.verifyStripeSignature(f.env,payload,await sign(payload,f.env.STRIPE_WEBHOOK_SECRET,now-100)),true);
  for(const t of [1,now-301,now+301])assert.equal(await B.verifyStripeSignature(f.env,payload,await sign(payload,f.env.STRIPE_WEBHOOK_SECRET,t)),false);
  const valid=await sign(payload,f.env.STRIPE_WEBHOOK_SECRET,now);
  assert.equal(await B.verifyStripeSignature(f.env,payload,`${valid},v1=${'0'.repeat(64)}`),true);
  assert.equal(await B.verifyStripeSignature(f.env,payload,`${valid},t=${now}`),false);
  assert.equal(await B.verifyStripeSignature(f.env,payload+' ',valid),false);
});

test('established owned key recovers current configured plan after upgrade without allowing fresh mismatch', async()=>{
  const f=fixture();await using(f,async()=>{
    const first=await B.provisionFromSession(f.env,'cs_test_fixture');
    f.subscription.items.data[0].price.id='price_pro';
    const recovered=await B.provisionFromSession(f.env,'cs_test_fixture');
    assert.equal(recovered.key,first.key);assert.equal(recovered.plan,'pro');assert.equal(records(f).length,1);
    f.session.customer='cus_other';await assert.rejects(()=>B.provisionFromSession(f.env,'cs_test_fixture'));
  });
});
