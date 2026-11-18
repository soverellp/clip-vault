"use strict";
const $=i=>document.getElementById(i),hex=h=>Uint8Array.from(h.match(/../g),b=>parseInt(b,16));
let cfg,token=null,clips=[],cur=null,urls=[];
const SAFE=/^(clips\/[\w.\-ऀ-ॿ]{1,200}\.(mp4|jpg|jpeg)|streams\/[A-Za-z0-9_.\-]{1,200}\/thumb\.jpg)$/;  // same pattern as site/hfstatic/src/hubapi.js: index.json comes from the dataset, so its paths are not trusted
const file=p=>{if(p!=="index.json"&&(typeof p!=="string"||p.includes("..")||!SAFE.test(p)))throw new Error("bad path");return `https://huggingface.co/datasets/${cfg.dataset}/resolve/main/${p}`};
async function hf(p,prog){const r=await fetch(file(p),{headers:{Authorization:"Bearer "+token},referrerPolicy:"no-referrer"});
 if(!r.ok)throw new Error(r.status);const len=+r.headers.get("content-length")||0,rd=r.body.getReader(),parts=[];let n=0;
 for(;;){const{done,value}=await rd.read();if(done)break;parts.push(value);n+=value.length;if(prog&&len)prog(n/len)}return new Blob(parts)}
async function unlock(pw){const E=new TextEncoder(),m=await crypto.subtle.importKey("raw",E.encode(pw),"PBKDF2",false,["deriveKey"]);
 const k=await crypto.subtle.deriveKey({name:"PBKDF2",salt:hex(cfg.salt),iterations:cfg.iter,hash:"SHA-256"},m,{name:"AES-GCM",length:256},false,["decrypt"]);
 return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:hex(cfg.iv)},k,hex(cfg.token)))}
fetch("config.json").then(r=>r.json()).then(c=>cfg=c);
$("f").onsubmit=async e=>{e.preventDefault();$("msg").textContent="Unlocking...";
 try{token=await unlock($("pw").value)}catch{$("msg").textContent="Wrong passphrase.";return}
 $("pw").value="";
 try{clips=JSON.parse(await(await hf("index.json")).text()).clips}catch{token=null;$("msg").textContent="Unlocked, but the vault is not reachable (token revoked or dataset missing).";return}
 $("f").hidden=true;$("msg").textContent="";$("app").hidden=false;filters();draw("")};
$("lock").onclick=()=>{token=null;clips=[];cur=null;urls.forEach(URL.revokeObjectURL);urls=[];cache={};$("v").removeAttribute("src");location.reload()};
function filters(){const s=[...new Set(clips.map(c=>c.stream))];$("flt").replaceChildren(...["",...s].map(x=>{const b=document.createElement("button");b.textContent=x?x.replace(/^\d{4}-\d\d-\d\d_/,"").replace(/-/g," "):"All";if(!x)b.className="on";
 b.onclick=()=>{[...$("flt").children].forEach(k=>k.classList.remove("on"));b.classList.add("on");draw(x)};return b}))}
function draw(s){const l=clips.filter(c=>!s||c.stream===s);$("cnt").textContent=l.length+" clips";
 $("grid").replaceChildren(...l.map(c=>{const d=document.createElement("div");d.className="c";d.innerHTML='<div class="p"></div><b></b><small></small>';
  d.querySelector("b").textContent=c.title;d.querySelector("small").textContent=Math.round(c.dur||0)+"s · "+((c.size||0)/1e6).toFixed(0)+" MB";d.onclick=()=>open(c);
  if(c.poster)poster(c,d.querySelector(".p"));return d}))}
let cache={};
async function poster(c,el){try{const u=URL.createObjectURL(await hf(c.poster));urls.push(u);el.style.backgroundImage=`url("${u}")`}catch{}}
async function open(c){cur=c;$("t").textContent=c.title;$("post").textContent=c.post||c.desc||"";$("v").hidden=$("dl").hidden=true;$("cp").hidden=!c.post;$("dlg").showModal();
 if(!cache[c.id]){$("st").textContent="Loading 0%";try{const u=URL.createObjectURL(await hf(c.video,p=>$("st").textContent="Loading "+Math.round(p*100)+"%"));urls.push(u);cache[c.id]=u}catch{$("st").textContent="Could not load this clip.";return}}
 $("st").textContent="";$("v").src=cache[c.id];$("v").hidden=false;$("dl").hidden=false;$("v").play().catch(()=>{})}
$("cp").onclick=()=>navigator.clipboard.writeText(cur.post);
$("dl").onclick=()=>{const a=document.createElement("a");a.href=cache[cur.id];a.download=cur.id+".mp4";a.click()};
$("x").onclick=()=>{$("v").pause();$("dlg").close()};
