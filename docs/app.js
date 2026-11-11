import {normalizeCandidatePair} from './candidate-pair.mjs';
const element = id => document.getElementById(id);
const status=element('status');
const evidence=element('evidence');
const lookup=new Map();
const key=(name,tail)=>name+'|'+tail;

async function load(url){
  const response=await fetch(url);
  if(!response.ok)throw Error('加载失败');
  return response.json();
}

for(const button of document.querySelectorAll('button[data-name]')){
  button.addEventListener('click',()=>{
    element('name').value=button.dataset.name;
    element('tail').value=button.dataset.tail;
  });
}
element('lookup').addEventListener('submit',event=>{
  event.preventDefault();
  evidence.replaceChildren();
  const pair=normalizeCandidatePair(element('name').value,element('tail').value);
  if(!pair){status.textContent='请输入页面给出的虚构姓名和证件尾号。';return;}
  const rows=lookup.get(key(pair.sampleName,pair.suffix)) || [];
  if(!rows.length){status.textContent='当前样例库暂无匹配。';return;}
  if(rows.length>1){
    status.textContent='找到 '+rows.length+' 条候选，存在同名同尾号冲突。';
    return;
  }
  status.textContent='找到 1 条候选，仍需复核。';
  const note=document.createElement('p');
  const row=rows[0];
  note.className='record';
  note.textContent='虚构来源 '+row.sourceRef+' · 第 '+row.page+' 页 · '+row.noticeDate;
  evidence.append(note);
});
try{
  const [base,bulk]=await Promise.all([load('./data/notice-candidates.json'),load('./data/synthetic-bulk.json')]);
  for(const row of [...base,...bulk]){
    const identifier=key(row.name,row.tail4);
    if(!lookup.has(identifier))lookup.set(identifier,[]);
    lookup.get(identifier).push(row);
  }
  status.textContent='已加载 '+(base.length+bulk.length).toLocaleString('zh-CN')+' 条虚构记录。';
  element('search').disabled=false;
}catch{status.textContent='样例加载失败，请刷新页面。';}
