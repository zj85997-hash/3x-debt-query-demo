import {createServer} from 'node:http';
import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pool, query} from './db.mjs';
import {normalizeCandidatePair} from './candidate-pair.mjs';

const port = Number(process.env.PORT || 8931);
const instance = process.env.INSTANCE_NAME || 'api-a';
const secret = process.env.DEMO_SIGNING_KEY;
if (process.env.DEMO_MODE !== '1' || !secret || secret.length < 32) {
  throw Error('Demo requires DEMO_MODE=1 and a shared DEMO_SIGNING_KEY of at least 32 characters.');
}

const profiles = {
  own:{label:'自有台账命中', key:'demo-own'},
  history:{label:'已核实历史转让', key:'demo-history'},
  candidate:{label:'脱敏公告待核实', key:'demo-candidate'},
  empty:{label:'无匹配记录', key:'demo-empty'},
  unavailable:{label:'查询服务异常', key:'demo-unavailable'},
  expired:{label:'授权已到期', key:'demo-expired'}
};
const windows = ['09:00–12:00','12:00–15:00','15:00–18:00'];
const policy = 'demo-query-v1';
const assets = new Map();
for (const [path, type] of [['index.html','text/html'],['style.css','text/css'],['app.js','text/javascript']]) {
  assets.set('/'+path, {type, bytes:await readFile(new URL('./public/'+path, import.meta.url))});
}

const fail = (status, message) => Object.assign(new Error(message), {status});
function sign(value) {
  return createHmac('sha256',secret).update(value).digest('base64url');
}
function mint(profile) {
  const payload = Buffer.from(JSON.stringify({profile, sub:randomUUID(), exp:Date.now()+3600000})).toString('base64url');
  return payload+'.'+sign(payload);
}
function identity(req) {
  try {
    const [payload, signature, extra] = (req.headers.authorization || '').replace(/^Bearer /,'').split('.');
    if (extra || !payload || !signature) throw Error();
    const expected=Buffer.from(sign(payload));
    const actual=Buffer.from(signature);
    if (expected.length!==actual.length || !timingSafeEqual(expected,actual)) throw Error();
    const session=JSON.parse(Buffer.from(payload,'base64url'));
    if (!validId(session.sub) || session.exp<Date.now() || !Object.hasOwn(profiles,session.profile)) throw Error();
    return {owner:session.sub, lookup:profiles[session.profile].key};
  } catch { throw fail(401,'请先完成模拟本人核验'); }
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415,'请发送 JSON');
  const chunks=[];
  let length=0;
  for await (const chunk of req) {
    length+=chunk.length;
    if (length>4096) throw fail(413,'请求内容过大');
    chunks.push(chunk);
  }
  try {
    const data=JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data!=='object' || Array.isArray(data)) throw Error();
    return data;
  } catch { throw fail(400,'请求内容格式有误'); }
}
function send(res, status, data) {
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'X-Demo-Instance':instance
  });
  res.end(JSON.stringify(data));
}
async function find(owner) {
  if (owner==='demo-unavailable') return {state:'unavailable'};
  const own = await query(
    'SELECT agency,origin,loan_date,principal,balance,as_of FROM authorized_assets WHERE owner_key=? AND authority_valid=1 ORDER BY id LIMIT 30',[owner]);
  if (own.length) return {state:'own',records:own};
  const notices = await query(
    'SELECT id,notice_date,amount,proof_kind FROM transfer_notices WHERE lookup_key=? ORDER BY id LIMIT 3',[owner]);
  if (notices.length===1 && notices[0].proof_kind==='verified_history') {
    return {state:'history', noticeDate:notices[0].notice_date, amount:notices[0].amount};
  }
  return {state:notices.length ? 'candidate' : 'empty'};
}
async function handle(req,res) {
  const path = new URL(req.url,'http://localhost').pathname;
  const method = req.method;
  if (method==='GET' && (path==='/' || assets.has(path))) {
    const asset=assets.get(path==='/'?'/index.html':path);
    res.writeHead(200,{
      'Content-Type':asset.type+'; charset=utf-8',
      'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; object-src 'none'; frame-ancestors 'none'",
      'Cache-Control':'no-cache'
    });
    return res.end(asset.bytes);
  }
  if (method==='GET' && path==='/livez') return send(res,200,{ok:true});
  if (method==='GET' && path==='/readyz') {
    await query('SELECT 1 FROM authorized_assets LIMIT 1');
    return send(res,200,{ok:true,instance});
  }
  if (method==='GET' && path==='/api/profiles') {
    return send(res,200,{profiles:Object.entries(profiles).map(([id,{label}])=>({id,label})),policy});
  }
  if (method==='POST' && path==='/api/session') {
    const {profile}=await body(req);
    if (typeof profile!=='string' || !Object.hasOwn(profiles,profile)) throw fail(400,'请选择演示账号');
    return send(res,200,{token:mint(profile)});
  }
  if (!path.startsWith('/api/')) throw fail(404,'页面不存在');
  const {owner,lookup}=identity(req);
  if (method==='POST' && path==='/api/query') {
    const input=await body(req);
    if (input.accepted!==true || input.policy!==policy) throw fail(400,'请阅读并同意当前查询说明');
    const result=await find(lookup);
    const requestId=randomUUID();
    await query('INSERT INTO query_events(id,owner_key,authorization_version,outcome) VALUES (?,?,?,?)',
      [requestId,owner,policy,result.state]);
    return send(res,result.state==='unavailable'?503:200,{...result,requestId});
  }
  if (method==='POST' && path==='/api/candidate-search') {
    const {name,tail4,accepted,policy:version}=await body(req);
    if (accepted!==true || version!==policy) throw fail(400,'请阅读并同意当前查询说明');
    const pair=normalizeCandidatePair(name,tail4);
    if (!pair) throw fail(400,'请输入页面给出的虚构姓名和证件尾号');
    const {sampleName,suffix}=pair;
    const rows=await query('SELECT source_ref,notice_date,source_page FROM synthetic_notice_candidates WHERE sample_name=? AND tail4=? ORDER BY source_ref LIMIT 21',[sampleName,suffix]);
    const state=rows.length>1?'ambiguous':rows.length?'candidate':'empty';
    const requestId=randomUUID();
    await query('INSERT INTO query_events(id,owner_key,authorization_version,outcome) VALUES (?,?,?,?)',[requestId,owner,policy,state]);
    return send(res,200,{state,requestId,candidateCount:rows.length,candidates:rows.length===1?rows:[]});
  }
  if (method==='POST' && path==='/api/unlock') {
    const {requestId, simulated}=await body(req);
    if (!validId(requestId) || simulated!==true) throw fail(400,'请选择模拟解锁');
    const [notice]=await query(`
      SELECT n.id,n.origin,n.receiver,n.notice_date,n.amount,n.source_ref
      FROM query_events q JOIN transfer_notices n ON n.lookup_key=?
      WHERE q.id=? AND q.owner_key=? AND q.outcome='history' AND n.proof_kind='verified_history'
      LIMIT 1`,[lookup,requestId,owner]);
    if (!notice) throw fail(404,'暂无可解锁的转让详情');
    await query('INSERT IGNORE INTO unlocks(owner_key,notice_id) VALUES (?,?)',[owner,notice.id]);
    return send(res,200,{...notice,contact:'示例受让机构官网客服（演示）',priceFen:990,simulated:true});
  }
  if (method==='GET' && path==='/api/callback') {
    return send(res,200,{requests:await query('SELECT id,time_window,state,created_at FROM callback_requests WHERE owner_key=? ORDER BY id DESC LIMIT 20',[owner])});
  }
  if (method==='POST' && path==='/api/callback') {
    const {requestId,timeWindow,contactAccepted}=await body(req);
    if (!validId(requestId) || !windows.includes(timeWindow) || contactAccepted!==true) throw fail(400,'请单独同意回访并选择时段');
    const result=await query(`
      INSERT IGNORE INTO callback_requests(owner_key,query_id,time_window)
      SELECT owner_key,id,? FROM query_events WHERE id=? AND owner_key=? AND outcome IN ('own','candidate','history','empty')`,
      [timeWindow,requestId,owner]);
    if (!result.affectedRows) {
      const [existing]=await query('SELECT id,state FROM callback_requests WHERE query_id=? AND owner_key=?',[requestId,owner]);
      if (existing) return send(res,200,existing);
      throw fail(404,'查询记录不可用');
    }
    return send(res,201,{id:result.insertId,state:'pending'});
  }
  if (method==='POST' && path==='/api/callback/withdraw') {
    const {id}=await body(req);
    if (!Number.isSafeInteger(id) || id<=0) throw fail(400,'工单编号无效');
    const result=await query("UPDATE callback_requests SET state='withdrawn' WHERE id=? AND owner_key=? AND state='pending'",[id,owner]);
    if (!result.affectedRows) throw fail(404,'未找到可取消的预约');
    return send(res,200,{state:'withdrawn'});
  }
  throw fail(404,'操作不存在');
}
function validId(id) {
  return typeof id==='string' && /^[0-9a-f-]{36}$/.test(id);
}
let inFlight=0;
const server=createServer({requestTimeout:8000, headersTimeout:5000, keepAliveTimeout:5000}, (req,res)=>{
  if (inFlight>=512) return send(res,503,{state:'unavailable',message:'服务繁忙，请稍后重试'});
  inFlight++;
  handle(req,res).catch(error=>{
    if (!res.headersSent) send(res,error.status || 503,{
      ...(error.status ? {} : {state:'unavailable'}),
      message:error.status ? error.message : '查询服务暂不可用，请稍后重试'
    });
    if (!error.status) console.error('dependency failure',error.code || error.name);
  }).finally(()=>{inFlight--;});
});
server.listen(port,process.env.HOST || '127.0.0.1',()=>console.log(instance+' listening on '+port));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
  server.close(async()=>{await pool.end(); process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
});
