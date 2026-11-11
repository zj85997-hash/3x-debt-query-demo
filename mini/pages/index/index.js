const {baseUrl}=require('../../config');
const messages={
  own:['自有授权资产','实际余额以服务机构复核为准。'],
  history:['有历史转让记录','当前债权状态需另行确认。'],
  candidate:['待人工核实','脱敏公告存在候选或冲突。'],
  empty:['暂无可展示记录','当前收录范围内未找到可展示资料。'],
  unavailable:['查询暂不可用','请稍后重试。']
};
const windowOptions=['09:00–12:00','12:00–15:00','15:00–18:00'];
const money=value=>(value/100).toFixed(2);
function api(path, payload, token){
  return new Promise((resolve,reject)=>wx.request({
    url:baseUrl+path,
    method:payload===undefined?'GET':'POST',
    data:payload,
    header:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
    timeout:6000,
    success(res){
      if((res.statusCode>=200 && res.statusCode<300) || (path==='/api/query' && res.data?.state==='unavailable'))resolve(res.data);
      else reject(Error(res.data?.message || '服务暂不可用'));
    },
    fail(){reject(Error('网络连接失败，请检查演示服务')); }
  }));
}
Page({
  data:{profiles:[],labels:[],selection:-1,accepted:false,busy:false,error:'',result:null,detail:null,
    windowOptions,windowIndex:0,contact:false,requests:[],message:'', sampleName:'',sampleTail:'',sampleAccepted:false,sampleBusy:false,sampleMessage:''},
  sessions:{},
  async onLoad(){
    try{
      const {profiles,policy}=await api('/api/profiles');
      this.policy=policy;
      this.setData({profiles,labels:profiles.map(x=>x.label)});
    }catch(error){this.setData({error:error.message});}
  },
  select(e){this.setData({selection:Number(e.detail.value)});},
  accept(e){this.setData({accepted:e.detail.value});},
  selectWindow(e){this.setData({windowIndex:Number(e.detail.value)});},
  contact(e){this.setData({contact:e.detail.value});},
  async search(){
    if(this.data.busy)return;
    const profile=this.data.profiles[this.data.selection];
    if(!profile || !this.data.accepted)return this.setData({error:'请选择演示场景并同意查询说明。'});
    this.setData({busy:true,error:'',result:null,detail:null,requests:[],message:'',contact:false});
    try{
      this.sessions[profile.id] ||= (await api('/api/session',{profile:profile.id})).token;
      this.token=this.sessions[profile.id];
      const result=await api('/api/query',{accepted:true,policy:this.policy},this.token);
      const [title,description]=messages[result.state];
      if(result.records)result.records=result.records.map(record=>({...record,principalText:money(record.principal),balanceText:money(record.balance)}));
      if(result.amount!==undefined)result.amountText=money(result.amount);
      this.setData({result:{...result,title,description}});
      await this.refresh();
    }catch(error){this.setData({error:error.message});}
    finally{this.setData({busy:false});}
  },
  fillSample(e){
    const {name,tail}=e.currentTarget.dataset;
    this.setData({sampleName:name,sampleTail:tail,sampleMessage:''});
  },
  inputName(e){this.setData({sampleName:e.detail.value});},
  inputTail(e){this.setData({sampleTail:e.detail.value});},
  acceptSample(e){this.setData({sampleAccepted:e.detail.value});},
  async searchCandidate(){
    if(this.data.sampleBusy)return;
    if(!this.data.sampleAccepted)return this.setData({sampleMessage:'请先同意查询说明。'});
    this.setData({sampleBusy:true,sampleMessage:''});
    try{
      this.candidateToken ||= (await api('/api/session',{profile:'candidate'})).token;
      const r=await api('/api/candidate-search',{name:this.data.sampleName,tail4:this.data.sampleTail,
        accepted:true,policy:this.policy},this.candidateToken);
      const row=r.candidates[0];
      this.setData({sampleMessage:r.state==='ambiguous'?'命中 '+r.candidateCount+' 条候选，需人工核实。':
        row?'命中 1 条候选，来源 '+row.source_ref+' 第 '+row.source_page+' 页。':'当前样例库暂无匹配。'});
    }catch(error){this.candidateToken='';this.setData({sampleMessage:error.message});}
    finally{this.setData({sampleBusy:false});}
  },
  async refresh(){
    const {requests}=await api('/api/callback',undefined,this.token);
    const stateText={pending:'待回访',replied:'已回复',withdrawn:'已取消'};
    this.setData({requests:requests.map(x=>({...x,stateText:stateText[x.state]}))});
  },
  async unlock(){
    if(this.data.busy)return;
    this.setData({busy:true,error:''});
    try{
      const detail=await api('/api/unlock',{requestId:this.data.result.requestId,simulated:true},this.token);
      this.setData({detail});
    }catch(error){this.setData({error:error.message});}
    finally{this.setData({busy:false});}
  },
  async book(){
    if(this.data.busy)return;
    if(!this.data.contact)return this.setData({message:'请单独确认回访意愿。'});
    this.setData({busy:true,message:''});
    try{
      const ticket=await api('/api/callback',{requestId:this.data.result.requestId,
        timeWindow:windowOptions[this.data.windowIndex],contactAccepted:true},this.token);
      this.setData({message:'预约 '+ticket.id+' 已登记。'});
      await this.refresh();
    }catch(error){this.setData({message:error.message});}
    finally{this.setData({busy:false});}
  },
  async withdraw(e){
    if(this.data.busy)return;
    this.setData({busy:true,error:''});
    try{
      await api('/api/callback/withdraw',{id:Number(e.currentTarget.dataset.id)},this.token);
      await this.refresh();
    }catch(error){this.setData({error:error.message});}
    finally{this.setData({busy:false});}
  }
});
