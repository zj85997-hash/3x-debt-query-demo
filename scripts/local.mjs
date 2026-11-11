import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readFile, access} from 'node:fs/promises';
import {createServer, request, Agent} from 'node:http';
import {resolve} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import mysql from 'mysql2/promise';

const local = resolve('.local');
const data = resolve(local,'mysql');
const suffix = createHash('sha256').update(local).digest('hex').slice(0,12);
const socket = resolve(tmpdir(),'debt-demo-'+suffix,'mysql.sock');
const gatewayPort = Number(process.env.GATEWAY_PORT || 8930);
const ports = [gatewayPort+1,gatewayPort+2];
const children = [];
let gateway, healthTimer, closing = false;
const env = {...process.env, DB_SOCKET:socket, DB_USER:'root', DB_PASSWORD:'',
  DEMO_MODE:'1', DEMO_SIGNING_KEY:randomBytes(36).toString('hex')};

function launch(command,args, options={}) {
  const child = spawn(command,args,{stdio:'inherit',...options});
  children.push(child);
  child.on('error',error=>console.error(command,error.message));
  return child;
}
async function run(command,args,options) {
  const [code] = await once(launch(command,args,options),'exit');
  if(code!==0) throw Error(command+' failed with code '+code);
}
async function retry(fn) {
  for(let attempt=0;attempt<100;attempt++){
    try{return await fn();}catch(error){if(attempt===99)throw error;await delay(300);}
  }
}
async function close() {
  if(closing)return;
  closing=true;
  clearInterval(healthTimer);
  gateway?.close();
  for(const child of children.reverse()) if(child.exitCode===null)child.kill('SIGTERM');
}
process.on('SIGTERM',close);
process.on('SIGINT',close);

try {
  await mkdir(data,{recursive:true,mode:0o700});
  await mkdir(resolve(socket,'..'),{recursive:true,mode:0o700});
  try{await access(resolve(data,'mysql.ibd'));}
  catch{await run('mysqld',['--no-defaults','--initialize-insecure','--datadir='+data]);}
  const db = launch('mysqld',['--no-defaults','--datadir='+data,'--socket='+socket,'--skip-networking','--mysqlx=OFF','--pid-file='+resolve(local,'mysql.pid'),'--log-error='+resolve(local,'mysql.log')]);
  db.on('exit',()=>{if(!closing){console.error('Local MySQL stopped');close();process.exitCode=1;}});
  const conn = await retry(()=>mysql.createConnection({socketPath:socket,user:'root',multipleStatements:true,connectTimeout:1000}));
  try{await conn.query(await readFile('deploy/schema.sql','utf8'));}finally{await conn.end();}
  await run(process.execPath,['scripts/seed.mjs',process.env.DEMO_ROWS || '450000'],{env});
  ports.forEach((port,index)=>launch(process.execPath,['server.mjs'],{env:{...env,HOST:'127.0.0.1',PORT:String(port),INSTANCE_NAME:index===0?'api-a':'api-b'}}));
  await Promise.all(ports.map(port=>retry(async()=>{
    const response=await fetch('http://127.0.0.1:'+port+'/readyz',{signal:AbortSignal.timeout(1500)});
    if(!response.ok)throw Error('API not ready');
  })));
  const agent = new Agent({keepAlive:true,maxSockets:320,maxFreeSockets:48});
  const healthy = new Set(ports);
  healthTimer=setInterval(()=>{
    for(const port of ports)fetch('http://127.0.0.1:'+port+'/readyz',{signal:AbortSignal.timeout(800)})
      .then(response=>{if(response.ok)healthy.add(port);else healthy.delete(port);return response.arrayBuffer();})
      .catch(()=>healthy.delete(port));
  },1000);
  healthTimer.unref();
  let next=0;
  gateway=createServer({requestTimeout:10000,headersTimeout:6000},(incoming,outgoing)=>{
    const candidates=ports.filter(port=>healthy.has(port));
    if(!candidates.length){
      outgoing.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return outgoing.end(JSON.stringify({state:'unavailable',message:'服务暂不可用，请重新发起查询'}));
    }
    const index=next++%candidates.length;
    const order=[candidates[index],candidates[(index+1)%candidates.length]];
    function forward(index){
      const upstream=request({hostname:'127.0.0.1',port:order[index],path:incoming.url,method:incoming.method,headers:incoming.headers,agent,timeout:8000},res=>{
        outgoing.writeHead(res.statusCode,res.headers);
        res.pipe(outgoing);
      });
      upstream.on('timeout',()=>upstream.destroy());
      upstream.on('error',()=>{
        healthy.delete(order[index]);
        if(index===0 && order[1]!==order[0] && ['GET','HEAD'].includes(incoming.method) && !outgoing.headersSent)return forward(1);
        if(outgoing.headersSent)return outgoing.destroy();
        outgoing.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
        outgoing.end(JSON.stringify({state:'unavailable',message:'服务暂不可用，请重新发起查询'}));
      });
      outgoing.once('close',()=>{if(!outgoing.writableEnded)upstream.destroy();});
      if(index===0)incoming.pipe(upstream);else upstream.end();
    }
    forward(0);
  });
  gateway.listen(gatewayPort,'127.0.0.1');
  await once(gateway,'listening');
  console.log('Demo: http://127.0.0.1:'+gatewayPort+'/');
}catch(error){console.error(error.message);await close();process.exitCode=1;}
