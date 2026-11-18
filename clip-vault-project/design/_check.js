const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();
for(const d of 'abc'){for(const hash of ['','#stream']){const p=await b.newPage({viewport:{width:360,height:740}});
await p.goto('file:///home/user/clipper/clip-vault-project/design/'+d+'/index.html'+hash);
if(hash){await p.click('label[for=cat-all]');}
const r=await p.evaluate(()=>{const small=[];for(const e of document.querySelectorAll('a,summary,label,button,input[type=search]')){const r=e.getBoundingClientRect();if(r.width&&r.height&&(r.height<43.5||r.width<43.5)&&e.offsetParent!==null&&!e.closest('.searchbox')){small.push((e.className||e.tagName)+':'+Math.round(r.width)+'x'+Math.round(r.height))}}
return {hs:document.documentElement.scrollWidth-innerWidth,small:[...new Set(small)].slice(0,8)}});
console.log(d,hash||'#home',JSON.stringify(r));await p.close()}}
// interaction test on A: Clean
const p=await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
for(const d of 'abc'){await p.goto('file:///home/user/clipper/clip-vault-project/design/'+d+'/index.html#stream');
 await p.click('label[for=cat-react]');await p.waitForTimeout(100);
 const first=await p.$('.m:visible .lc') ;
 await p.evaluate(()=>{const m=[...document.querySelectorAll('.m')].find(e=>e.offsetParent&&!e.classList.contains('best'));m.querySelector('.lc').click()});
 await p.waitForTimeout(500);await p.evaluate(()=>window.scrollTo(0,d_=0));
 await p.evaluate(()=>{const m=[...document.querySelectorAll('.m')].find(e=>e.offsetParent&&!e.classList.contains('best'));m.scrollIntoView({block:'center'})});
 await p.waitForTimeout(300);await p.screenshot({path:'/tmp/'+d+'-clean.png'});
 await p.click('label[for=theme]',{force:true}).catch(()=>{});
}
await b.close()})()
