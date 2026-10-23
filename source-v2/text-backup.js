const TextBackup=(()=>{
  const names=[['','本机访客'],['zhang-jiahao','张佳昊'],['ji-yaqun','纪亚群'],['huang-chunlin','黄春林']];
  let parts=[],checked=null,checkTimer=null,checkSequence=0;
  const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
  const digest=text=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)).then(hex);
  const base64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.slice(i,i+8192));return btoa(s);};
  function close(){clearTimeout(checkTimer);checkSequence++;document.querySelector('#text-backup-dialog')?.remove();checked=null;}
  function shell(title,body){close();const el=document.createElement('div');el.className='backup-overlay';el.id='text-backup-dialog';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label',title);el.innerHTML=`<section class="backup-panel"><div class="section-head"><h2>${escape(title)}</h2><button class="btn small outline" data-backup-close>关闭</button></div>${body}<p id="backup-message" role="status" class="small"></p></section>`;document.body.appendChild(el);el.querySelector('[data-backup-close]').focus();el.addEventListener('click',event=>{if(event.target===el)close();});return el;}
  function message(text){const el=document.querySelector('#backup-message');if(el)el.textContent=text;}
  async function encode(raw){
    const json=JSON.stringify(raw),sum=await digest(json);
    if(typeof CompressionStream==='undefined')return [json];
    const stream=new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    const encoded=base64(new Uint8Array(await new Response(stream).arrayBuffer()));
    const chunks=encoded.match(/.{1,2800}/g)||[''];
    return chunks.map((part,i)=>`CAAC-PROGRESS-V2|gzip|${i+1}/${chunks.length}|${sum}\n${part}`);
  }
  async function decode(text){
    if(text.length>4000000)throw Error('备份文字过长，请检查粘贴内容。');
    text=text.replace(/[\u200b-\u200f\ufeff]/g,'').trim();let parsed;
    if(text.startsWith('{'))parsed=JSON.parse(text);
    else{
      text=text.replace(/[｜¦]/g,'|');
      const regex=/CAAC-PROGRESS-V2\s*\|\s*gzip\s*\|\s*(\d+)\s*\/\s*(\d+)\s*\|\s*([a-f0-9]{64})/g;
      const items=[...text.matchAll(regex)];if(!items.length)throw Error('没有识别到进度备份，请粘贴完整文字或原JSON内容。');
      const total=Number(items[0][2]),sum=items[0][3],map=new Map();
      if(total<1||total>1000)throw Error('备份分段数量无效。');
      for(const [n,x]of items.entries()){if(Number(x[2])!==total||x[3]!==sum)throw Error('混入了不同时间生成的备份，请只保留同一份。');const i=Number(x[1]);if(i<1||i>total)throw Error('分段编号无效。');const body=text.slice(x.index+x[0].length,items[n+1]?.index??text.length).replace(/\s/g,'');if(!/^[A-Za-z0-9+/=]+$/.test(body))throw Error('备份段内含额外文字，请仅粘贴备份内容。');if(map.has(i)&&map.get(i)!==body)throw Error('同一分段出现了不同内容。');map.set(i,body);}
      if(map.size!==total)throw Error(`备份不完整：应有${total}段，已粘贴${map.size}段；请把微信里其余分段一起粘贴。`);
      const encoded=Array.from({length:total},(_,i)=>map.get(i+1)).join('');let bytes;try{bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));}catch{throw Error('备份编码有误，请重新复制。');}
      if(typeof DecompressionStream==='undefined')throw Error('此浏览器暂不支持解压备份，请使用新版Chrome、Edge或Safari。');
      const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),chunks=[];let length=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>5000000){reader.cancel();throw Error('解压后的备份超出上限。');}chunks.push(value);}}catch{throw Error('备份内容不完整或已损坏，请重新复制完整备份；当前进度未改。');}
      const decoded=new Uint8Array(length);let offset=0;for(const chunk of chunks){decoded.set(chunk,offset);offset+=chunk.length;}const json=new TextDecoder().decode(decoded);
      if(await digest(json)!==sum)throw Error('备份校验失败，文字可能缺失或被改动；当前进度未改。');parsed=JSON.parse(json);
    }
    const source=parsed.state||parsed;
    return {state:E.validate(source,{allowSession:true}),hint:parsed.profileHint||null,date:parsed.exportedAt||null};
  }
  async function copy(text){
    try{await navigator.clipboard.writeText(text);message('已复制。请自行粘贴到微信文件传输助手保存。');return true;}
    catch{const area=document.querySelector('#backup-text');area.value=text;area.focus();area.select();if(document.execCommand('copy')){message('已复制。请粘贴到微信文件传输助手保存。');return true;}message('浏览器限制了自动复制，文字已选中，请长按或按Ctrl+C复制。');return false;}
  }
  async function openCopy(){
    V2.clock.settle();save();
    shell('复制进度备份','<p class="small muted">无需下载。复制后粘贴到微信文件传输助手；在其他浏览器打开本网站，点“粘贴恢复”。文字内含个人做题记录，请自行保管。</p><textarea id="backup-text" rows="9" readonly aria-label="进度备份文字">正在生成…</textarea><div class="actions" id="backup-copy-actions"></div>');
    try{parts=await encode({format:'caac-text-progress-v2',state:E.validate(state,{allowSession:true}),profileHint:V2.Cloud.profile,exportedAt:new Date().toISOString()});const area=document.querySelector('#backup-text');if(!area)return;area.value=parts.join('\n\n');document.querySelector('#backup-copy-actions').innerHTML='<button class="btn primary" data-backup-copy="all">复制整份备份</button>'+ (parts.length>1?parts.map((_,i)=>`<button class="btn small outline" data-backup-copy="${i}">复制第${i+1}/${parts.length}段</button>`).join(''):'');message(parts.length>1?`共${parts.length}段。如微信提示文字过长，请逐段复制并发送；恢复时把所有分段一起粘贴，顺序不限。`:'备份已生成。');}
    catch(error){message('生成失败：'+error.message);}
  }
  function openRestore(){
    shell('粘贴恢复进度',`<p class="small muted">粘贴微信里保存的全部备份文字，也支持旧版JSON备份。先检查再合并，不会自动按备份里的姓名切换用户。</p><label>恢复到 <select id="backup-target">${names.map(([id,name])=>`<option value="${id}" ${id===(V2.Cloud.profile||'')?'selected':''}>${name}</option>`).join('')}</select></label><textarea id="backup-text" rows="10" placeholder="在这里粘贴完整备份；分段备份需全部粘贴" aria-label="粘贴进度备份"></textarea><div class="actions"><button class="btn outline" data-backup-check>检查备份</button><button class="btn primary" data-backup-restore disabled>确认合并恢复</button></div><p class="small muted">重复题目保留提交次数较多的记录，不把同一份旧备份反复累加。恢复到姓名后会自动上传；本机旧存储不清空。</p>`);
    message('粘贴后会自动检查；检查通过才可确认恢复，不会自动修改进度。');
  }
  async function checkBackup(){
    clearTimeout(checkTimer);const ticket=++checkSequence;
    const area=document.querySelector('#backup-text'),button=document.querySelector('[data-backup-restore]');if(!area||!button)return;
    const text=area.value;checked=null;button.disabled=true;
    if(!text.trim()){message('请先粘贴备份文字。');return;}
    message('正在检查备份…');
    try{const result=await decode(text);if(ticket!==checkSequence||!area.isConnected||area.value!==text)return;checked=result;const records=Object.values(checked.state.records);message(`校验通过：${records.length}道已答题，${records.reduce((n,r)=>n+r.attempts,0)}次提交，${checked.state.exams?.history?.length||0}次模拟考试。${checked.hint?'备份原用户：'+(names.find(p=>p[0]===checked.hint)?.[1]||'其他用户')+'。':''}${records.length?'请确认目标姓名后点“确认合并恢复”。':'这份备份没有已答题记录；如果要找回已做题目，请回到原来做题的浏览器，用“本机访客”重新复制进度。'}`);button.disabled=false;}
    catch(error){if(ticket===checkSequence&&area.isConnected)message('检查失败：'+error.message);}
  }
  document.addEventListener('click',async event=>{
    if(event.target.closest('[data-backup-close]')){close();return;}
    const open=event.target.closest('[data-text-backup]');if(open){if(open.dataset.textBackup==='copy')await openCopy();else openRestore();return;}
    const button=event.target.closest('[data-backup-copy]');if(button){await copy(button.dataset.backupCopy==='all'?parts.join('\n\n'):parts[Number(button.dataset.backupCopy)]);return;}
    if(event.target.closest('[data-backup-check]')){
      await checkBackup();
    }
    const restore=event.target.closest('[data-backup-restore]');if(restore&&!restore.disabled&&checked){
      restore.disabled=true;const target=document.querySelector('#backup-target').value,name=names.find(p=>p[0]===target)[1];
      try{const imported=checked.state;await V2.mergeBackup(imported,target);close();toast('已合并到'+name+(target?'，云端状态请看页面顶部。':'。'));}
      catch(error){message('恢复失败：'+error.message+'；原记录仍保留。');restore.disabled=false;}
    }
  });
  document.addEventListener('input',event=>{if(event.target.id==='backup-text'&&document.querySelector('[data-backup-restore]')){checked=null;checkSequence++;clearTimeout(checkTimer);document.querySelector('[data-backup-restore]').disabled=true;message('正在等待粘贴完成，随后自动检查…');checkTimer=setTimeout(checkBackup,350);}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
  return {encode,decode,openCopy,openRestore,copy};
})();
