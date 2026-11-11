import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {base} from './api-test.mjs';

let definition;
const wx={
  request({url,method,header,data,success,fail}){
    fetch(url,{method,headers:header,body:data===undefined?undefined:JSON.stringify(data)})
      .then(async response=>success({statusCode:response.status,data:await response.json()})).catch(fail);
  }
};
vm.runInNewContext(await readFile('mini/pages/index/index.js','utf8'),{
  wx, require:name=>{
    assert.equal(name,'../../config');
    return {baseUrl:base};
  },Page:value=>{definition=value;}
});
const page={...definition,setData(patch){Object.assign(this.data,patch);}};
await page.onLoad();
page.select({detail:{value:page.data.profiles.findIndex(x=>x.id==='history')}});
page.accept({detail:{value:true}});
await page.search();
assert.equal(page.data.result.state,'history');
await page.unlock();
assert.equal(page.data.detail.simulated,true);
page.contact({detail:{value:true}});
await page.book();
assert.equal(page.data.requests[0].state,'pending');
await page.withdraw({currentTarget:{dataset:{id:page.data.requests[0].id}}});
assert.equal(page.data.requests[0].state,'withdrawn');
page.fillSample({currentTarget:{dataset:{name:'样例重名',tail:'8042'}}});
page.acceptSample({detail:{value:true}});
await page.searchCandidate();
assert.match(page.data.sampleMessage,/2 条候选/);
console.log('PASS: 小程序页面脚本已通过真实本地 API 联调。微信渲染和真机留待开发者工具验证。');
