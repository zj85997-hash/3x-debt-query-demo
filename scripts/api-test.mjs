export const base=process.env.DEMO_BASE || 'http://127.0.0.1:8930';
const target=new URL(base);
if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw Error('测试脚本仅访问本机 Demo');
export async function call(path, data, token) {
  const response=await fetch(base+path,{
    method:data===undefined?'GET':'POST',
    headers:{
      ...(data===undefined?{}:{'Content-Type':'application/json'}),
      ...(token?{Authorization:'Bearer '+token}:{})
    },
    body:data===undefined?undefined:JSON.stringify(data),
    signal:AbortSignal.timeout(6000)
  });
  return {status:response.status,instance:response.headers.get('x-demo-instance'),body:await response.json()};
}
export async function session(profile){
  const response=await call('/api/session',{profile});
  if(response.status!==200 || !response.body.token)throw Error('模拟登录失败');
  return response.body.token;
}
