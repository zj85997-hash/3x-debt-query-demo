const $=id=>document.getElementById(id);
const money=fen=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(fen/100);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states={
  own:['自有授权资产','按当前业务台账显示。实际余额以服务机构复核为准。'],
  history:['有历史转让记录','已核实的演示历史记录，当前债权状态需另行确认。'],
  candidate:['待人工核实','脱敏公告存在候选或冲突，需要人工核实。'],
  empty:['暂无可展示记录','本次收录范围内未找到记录。你仍可申请人工协助。'],
  unavailable:['查询暂不可用','请稍后重新查询。']
};
const fields=entries=>'<dl>'+entries.map(([label,value])=>'<dt>'+escape(label)+'</dt><dd>'+escape(value)+'</dd>').join('')+'</dl>';
let token='', policy='';
const sessions=new Map();
async function api(url, payload, override=token) {
  const response=await fetch(url,{method:payload===undefined?'GET':'POST',headers:{
    ...(payload===undefined?{}:{'Content-Type':'application/json'}),
    ...(override?{'Authorization':'Bearer '+override}:{})
  },body:payload===undefined?undefined:JSON.stringify(payload)});
  const data=await response.json();
  if (!response.ok && !(url==='/api/query' && data.state==='unavailable')) {
    throw Object.assign(Error(data.message || '操作失败'),{status:response.status});
  }
  return data;
}
function render(data) {
  const [status,description]=states[data.state];
  let content='';
  if (data.state==='own') {
    content=data.records.map((a,i)=>'<div class="record"><h3>账户 '+(i+1)+'</h3>'+fields([
      ['债权主体',a.agency],['原贷款方',a.origin],['贷款日期',a.loan_date],
      ['贷款本金',money(a.principal)],['欠款本息',money(a.balance)],['数据日期',a.as_of]
    ])+'</div>').join('');
  }
  if (data.state==='history') content='<div class="record">'+fields([['历史转让日期',data.noticeDate],['历史转让金额',money(data.amount)]])+'</div><button type="button" class="secondary" id="unlock">模拟 ¥9.90 解锁详情</button><div id="detail"></div>';
  const callback=data.state==='unavailable'?'':'<form class="actions" id="callback-form"><h3>申请人工协助</h3><label class="field">回访时段<select id="window"><option>09:00–12:00</option><option>12:00–15:00</option><option>15:00–18:00</option></select></label><label class="check"><input id="contact" type="checkbox" required>我自愿申请回访（模拟）</label><button>提交预约</button><p id="callback-message" class="feedback" role="status"></p></form>';
  $('result').innerHTML='<div class="heading"><h2>查询结果</h2><span class="status">'+status+'</span></div><p class="muted">'+description+'</p>'+content+callback;
  $('unlock')?.addEventListener('click',async e=>{
    e.target.disabled=true;
    try{
      const detail=await api('/api/unlock',{requestId:data.requestId,simulated:true});
      $('detail').innerHTML='<div class="record">'+fields([['出让方',detail.origin],['历史受让方',detail.receiver],['公告编号',detail.source_ref],['机构联系渠道',detail.contact]])+'<p class="feedback">模拟解锁成功，未发生扣款。</p></div>';
    }catch(error){ $('detail').textContent=error.message; e.target.disabled=false; }
  });
  $('callback-form')?.addEventListener('submit',async e=>{
    e.preventDefault();
    const button=e.target.querySelector('button');
    button.disabled=true;
    try{
      const ticket=await api('/api/callback',{requestId:data.requestId,timeWindow:$('window').value,contactAccepted:$('contact').checked});
      $('callback-message').textContent='预约 '+ticket.id+' 已登记。';
      await renderRequests();
    }catch(error){ $('callback-message').textContent=error.message; }
    finally{ button.disabled=false; }
  });
}
async function renderRequests(){
  const {requests}=await api('/api/callback');
  $('appointments').hidden=!requests.length;
  $('requests').innerHTML=requests.map(x=>'<div class="request"><span>预约 '+x.id+' · '+escape(x.time_window)+' · '+({pending:'待回访',replied:'已回复',withdrawn:'已取消'}[x.state])+'</span>'+(x.state==='pending'?'<button class="secondary" data-id="'+x.id+'">取消预约</button>':'')+'</div>').join('');
}
$('requests').addEventListener('click',async e=>{
  if(!e.target.matches('button[data-id]'))return;
  e.target.disabled=true;
  try{await api('/api/callback/withdraw',{id:Number(e.target.dataset.id)});await renderRequests();}
  catch(error){e.target.textContent=error.message;e.target.disabled=false;}
});
$('query-form').addEventListener('submit',async e=>{
  e.preventDefault();
  $('submit').disabled=true;
  $('form-error').textContent='';
  $('appointments').hidden=true;
  $('requests').replaceChildren();
  $('result').innerHTML='<h2>查询结果</h2><p class="muted">正在核对演示记录…</p>';
  try{
    const profile=$('profile').value;
    if(!sessions.has(profile)) sessions.set(profile,(await api('/api/session',{profile},'')).token);
    token=sessions.get(profile);
    const result=await api('/api/query',{accepted:$('accepted').checked,policy});
    render(result);
    await renderRequests();
  }catch(error){
    if(error.status===401)sessions.delete($('profile').value);
    $('form-error').textContent=error.message;render({state:'unavailable'});
  }
  finally{$('submit').disabled=false;}
});
try{
  const data=await api('/api/profiles');
  policy=data.policy;
  $('profile').innerHTML='<option value="">请选择演示场景</option>'+data.profiles.map(x=>'<option value="'+escape(x.id)+'">'+escape(x.label)+'</option>').join('');
}catch(error){$('form-error').textContent='无法载入演示场景，请刷新页面。';}

let candidateToken='';
document.querySelectorAll('.sample').forEach(button=>button.addEventListener('click',()=>{
  $('sample-name').value=button.dataset.name;
  $('sample-tail').value=button.dataset.tail;
}));
$('candidate-form').addEventListener('submit',async e=>{
  e.preventDefault();
  $('candidate-submit').disabled=true;
  $('candidate-output').textContent='正在查询样例索引…';
  try{
    candidateToken ||= (await api('/api/session',{profile:'candidate'},'')).token;
    const data=await api('/api/candidate-search',{name:$('sample-name').value,tail4:$('sample-tail').value,
      accepted:$('candidate-accepted').checked,policy},candidateToken);
    const row=data.candidates[0];
    $('candidate-output').textContent=data.state==='ambiguous'
      ? '命中 '+data.candidateCount+' 条候选，需人工核实。'
      : row ? '命中 1 条候选，来源 '+row.source_ref+' 第 '+row.source_page+' 页，公告日期 '+row.notice_date+'。'
        : '当前样例库暂无匹配。';
  }catch(error){
    if(error.status===401)candidateToken='';
    $('candidate-output').textContent=error.message;
  }finally{$('candidate-submit').disabled=false;}
});
