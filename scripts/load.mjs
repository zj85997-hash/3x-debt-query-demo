import {writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {call,session} from './api-test.mjs';
const users=Number(process.env.VUS || 500);
const seconds=Number(process.env.DURATION_SECONDS || 60);
if(!Number.isInteger(users) || users<1 || users>1000 || !Number.isFinite(seconds) || seconds<1 || seconds>600)throw Error('Invalid load settings');
const {body:{policy}}=await call('/api/profiles');
const scenarios=['own','history','candidate','empty','one','ambiguous'];
const candidateInputs={one:{name:'样例甲',tail4:'0067',state:'candidate'},ambiguous:{name:'样例重名',tail4:'8042',state:'ambiguous'}};
const actors=[];
for(let start=0;start<users;start+=50){
  const batch=Array.from({length:Math.min(50,users-start)},(_,i)=>scenarios[(start+i)%scenarios.length]);
  actors.push(...await Promise.all(batch.map(async profile=>({profile,token:await session(candidateInputs[profile]?'candidate':profile)}))));
}
const payload={accepted:true,policy};

function phase(){
  const durations=[];
  const instances={};
  const failures={};
  let requests=0;
  let active=0;
  let peak=0;
  const start=performance.now();
  return {
    async query({profile,token}){
      const queryStart=performance.now();
      peak=Math.max(peak,++active);
      requests++;
      try{
        const candidate=candidateInputs[profile];
        const r=candidate
          ? await call('/api/candidate-search',{...payload,name:candidate.name,tail4:candidate.tail4},token)
          : await call('/api/query',payload,token);
        if(r.instance)instances[r.instance]=(instances[r.instance] || 0)+1;
        if(r.status!==200 || r.body.state!==(candidate?.state || profile)){
          const key=r.status+':'+String(r.body.state);
          failures[key]=(failures[key]||0)+1;
        }else durations.push(performance.now()-queryStart);
      }catch(error){failures[error.name]=(failures[error.name]||0)+1;}
      finally{active--;}
    },
    report(){
      const elapsed=(performance.now()-start)/1000;
      durations.sort((a,b)=>a-b);
      const percentile=p=>Math.round(durations[Math.ceil(durations.length*p)-1] ?? -1);
      return {requests,success:durations.length,successRate:durations.length/requests,elapsedSeconds:Number(elapsed.toFixed(2)),
        peakInFlight:peak,requestsPerSecond:Number((requests/elapsed).toFixed(2)),p50Ms:percentile(.5),p95Ms:percentile(.95),
        p99Ms:percentile(.99),instances,failures};
    }
  };
}
const steady=phase();
const deadline=performance.now()+seconds*1000;
await Promise.all(actors.map(async(actor,i)=>{
  await sleep(i%2000);
  while(performance.now()<deadline){
    await steady.query(actor);
    const remaining=deadline-performance.now();
    if(remaining>0)await sleep(Math.min(remaining,2000+Math.random()*2000));
  }
}));
const steadyReport=steady.report();
const burst=phase();
await Promise.all(actors.map(actor=>burst.query(actor)));
const burstReport=burst.report();
const passed=steadyReport.successRate>=.995 && burstReport.successRate>=.995
  && steadyReport.p95Ms<=1000 && burstReport.p95Ms<=3000
  && Object.keys(steadyReport.instances).length>=2;
const report={date:new Date().toISOString(),users,durationSeconds:seconds,scenarios,thresholds:{successRate:.995,steadyP95Ms:1000,burstP95Ms:3000},
  steady:steadyReport,burst:burstReport,passed};
await writeFile(process.env.REPORT || '压测结果.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(!passed)process.exitCode=1;
