import assert from 'node:assert/strict';
import {call,session} from './api-test.mjs';
const {body:{policy}}=await call('/api/profiles');
const auth={accepted:true,policy};
const scenarios=[
  ['own','own',200],['history','history',200],['candidate','candidate',200],
  ['empty','empty',200],['expired','empty',200],['unavailable','unavailable',503]
];
const results={};
const instances=new Set();
for(const [profile,state,status] of scenarios){
  const token=await session(profile);
  const response=await call('/api/query',auth,token);
  assert.equal(response.status,status,profile);
  assert.equal(response.body.state,state,profile);
  results[profile]={token,body:response.body};
  instances.add(response.instance);
}
assert.equal(results.own.body.records.length,2);
assert.equal(results.candidate.body.records,undefined);
assert.equal(results.history.body.receiver,undefined);
assert.equal((await call('/api/query',auth)).status,401);
assert.equal((await call('/api/query',{...auth,accepted:false},results.own.token)).status,400);
assert.equal((await call('/api/query',auth,results.own.token+'invalid')).status,401);
const unlock={requestId:results.history.body.requestId,simulated:true};
assert.equal((await call('/api/unlock',unlock,results.own.token)).status,404);
const secondHistory=await session('history');
assert.equal((await call('/api/unlock',unlock,secondHistory)).status,404);
const detail=await call('/api/unlock',unlock,results.history.token);
assert.equal(detail.status,200);
assert.equal(detail.body.priceFen,990);
assert.equal(detail.body.simulated,true);
assert.deepEqual((await call('/api/unlock',unlock,results.history.token)).body,detail.body);

const appointment={requestId:results.own.body.requestId,timeWindow:'09:00–12:00',contactAccepted:true};
assert.equal((await call('/api/callback',appointment,results.history.token)).status,404);
assert.equal((await call('/api/callback',{...appointment,contactAccepted:false},results.own.token)).status,400);
const pair=await Promise.all([call('/api/callback',appointment,results.own.token),call('/api/callback',appointment,results.own.token)]);
assert.deepEqual(pair.map(x=>x.status).sort(),[200,201]);
assert.equal(pair[0].body.id,pair[1].body.id);
const id=pair[0].body.id;
assert.equal((await call('/api/callback/withdraw',{id},results.history.token)).status,404);
assert.equal((await call('/api/callback/withdraw',{id},results.own.token)).status,200);
assert.equal((await call('/api/callback',undefined,results.own.token)).body.requests[0].state,'withdrawn');
assert.equal((await call('/api/callback',undefined,await session('own'))).body.requests.length,0);
for(let i=0;i<4;i++)instances.add((await call('/readyz')).instance);
assert.equal(instances.size,2,'Expected two reachable instances');
console.log('PASS: 6个查询场景、授权校验、同场景跨会话隔离、模拟解锁幂等、预约并发去重与撤回、双实例');
