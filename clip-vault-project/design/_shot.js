const {chromium}=require('playwright');const path=require('path');
(async()=>{const dirs=process.argv[2]||'abc';const b=await chromium.launch();
for(const d of dirs){const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
 const p=await ctx.newPage();const u='file://'+path.resolve(__dirname,d,'index.html');
 await p.goto(u);await p.waitForTimeout(300);await p.screenshot({path:`${__dirname}/${d}-home-mobile.png`});
 await p.goto(u+'#stream');await p.waitForTimeout(300);await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:`${__dirname}/${d}-stream-mobile.png`});
 // overflow check
 const ov=await p.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);console.log(d,'hscroll',ov);
 await ctx.close();}
if(process.argv[3]==='desk'){const ctx=await b.newContext({viewport:{width:1280,height:800}});const p=await ctx.newPage();
 const u='file://'+path.resolve(__dirname,process.argv[2][0],'index.html');await p.goto(u+'#stream');await p.waitForTimeout(300);await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:__dirname+'/recommended-desktop.png'});}
await b.close();})();
