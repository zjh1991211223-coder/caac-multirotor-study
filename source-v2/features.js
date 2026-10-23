/* Three name-only shared profiles. This is deliberately not authentication. */
const V2 = (() => {
  const config=JSON.parse(document.getElementById('cloud-config').textContent);
  const profiles=[['zhang-jiahao','张佳昊'],['ji-yaqun','纪亚群'],['huang-chunlin','黄春林']];
  const clone=x=>JSON.parse(JSON.stringify(x)), uuid=()=>crypto.randomUUID();
  const chosenKey='caac-selected-profile-v2', deviceKey='caac-device-v2';
  let device;try{device=localStorage.getItem(deviceKey)||uuid();localStorage.setItem(deviceKey,device);}catch{device=uuid();}
  const register=E.register, oldSave=save, oldRender=render;
  const Cloud={profile:null,pack:null,busy:false,inFlight:new Set(),message:'未选择用户 · 本机进度',lastSync:0,timer:null,uiSnapshot:'',recordsSnapshot:'',problem:'',diagnostics:[],ready:Promise.resolve()};
  const cacheKey=p=>'caac-profile-events-v2:'+bank.id+':'+p;
  const uiOf=s=>({session:s.session,prefs:s.prefs,picked:s.picked,activeExam:s.exams?.active||null});
  const freshPack=()=>({cursor:0,base:E.fresh(),pending:[],seen:{}});
  function persist(){
    if(!Cloud.profile)return;
    try{localStorage.setItem(cacheKey(Cloud.profile),JSON.stringify(Cloud.pack));}
    catch{Cloud.problem='本机缓存保存失败，请保持页面打开并导出备份。';}
    status();
  }
  function apply(target,event){
    const p=event.payload||{};
    if(event.kind==='answer'){
      if(!questions.has(p.id))return;
      const r=register(target,p.id,p.answer,{at:p.at,day:p.day,elapsedMs:p.elapsedMs});
      if(target.session&&p.sessionId&&target.session.uid===p.sessionId)target.session.results[p.id]={...r,elapsedMs:p.elapsedMs};
    }else if(event.kind==='ui'){
      if(p.prefs)target.prefs=E.validate({...target,prefs:p.prefs}).prefs;
      if(Array.isArray(p.picked))target.picked=p.picked.filter(id=>questions.has(id));
      if(Object.hasOwn(p,'session')){const s=E.validate({...target,session:p.session},{allowSession:true}).session;if(s&&s.uid===target.session?.uid){s.results={...target.session.results,...s.results};s.timeSpent={...target.session.timeSpent,...s.timeSpent};}target.session=s;}
      if(Object.hasOwn(p,'activeExam')){target.exams||={active:null,history:[]};let next=validateExam(p.activeExam);const previous=target.exams.active;if(next&&target.exams.history.some(x=>x.id===next.id))next=null;if(next&&next.id===previous?.id){next.answers={...previous.answers,...next.answers};for(const [id,ms]of Object.entries(previous.timeSpent||{}))next.timeSpent[id]=Math.max(ms,next.timeSpent[id]||0);}target.exams.active=next;}
    }else if(event.kind==='seed'){
      const imported=E.validate(p.state,{allowSession:true});
      const wasEmpty=!Object.keys(target.records).length;
      for(const [id,r]of Object.entries(imported.records))if(!target.records[id]||r.attempts>target.records[id].attempts)target.records[id]=r;
      if(!target.session&&imported.session)target.session=imported.session;
      if(wasEmpty){target.prefs=imported.prefs;target.picked=imported.picked;}
      target.exams||={active:null,history:[]};
      for(const exam of imported.exams?.history||[])if(validateResult(exam)&&!target.exams.history.some(x=>x.id===exam.id))target.exams.history.push(exam);
      if(!target.exams.active&&validateExam(imported.exams?.active)&&!target.exams.history.some(x=>x.id===imported.exams.active.id))target.exams.active=imported.exams.active;
    }else if(event.kind==='exam'){
      if(!validateResult(p.result))return;
      target.exams||={active:null,history:[]};
      if(!target.exams.history.some(x=>x.id===p.result.id))target.exams.history.push(p.result);
      if(target.exams.active?.id===p.result.id)target.exams.active=null;
    }
  }
  function projected(){
    const s=clone(Cloud.pack.base);
    for(const event of Cloud.pack.pending)if(!Cloud.pack.seen[event.id])apply(s,event);
    const checkpoint=Cloud.pack.localTiming;
    if(checkpoint&&questions.has(checkpoint.question)&&Number.isFinite(checkpoint.ms)&&checkpoint.ms>=0){const active=checkpoint.kind==='exam'?s.exams?.active:s.session;if(active&&(active.uid||active.id)===checkpoint.id){active.timeSpent||={};active.timeSpent[checkpoint.question]=Math.max(active.timeSpent[checkpoint.question]||0,checkpoint.ms);}}
    return s;
  }
  function remember(){Cloud.uiSnapshot=JSON.stringify(uiOf(state));Cloud.recordsSnapshot=JSON.stringify(state.records);}
  function queue(kind,payload,id=uuid()){
    if(!Cloud.profile)return;
    if(Cloud.pack.seen[id]||Cloud.pack.pending.some(e=>e.id===id))return;
    const previous=kind==='ui'?[...Cloud.pack.pending].reverse().find(e=>e.kind==='ui'&&!Cloud.inFlight.has(e.id)):null;
    if(previous)previous.payload=clone(payload);else Cloud.pack.pending.push({id,device_id:device,kind,payload:clone(payload)});persist();
    clearTimeout(Cloud.timer);Cloud.timer=setTimeout(()=>sync(),200);
  }
  function capture(){
    if(!Cloud.profile)return oldSave();
    if(writeBlocked){showStorageNotice();return false;}
    if(JSON.stringify(state.records)!==Cloud.recordsSnapshot)queue('seed',{state:E.validate(state,{allowSession:true})});
    const ui=JSON.stringify(uiOf(state));if(ui!==Cloud.uiSnapshot)queue('ui',uiOf(state));
    remember();persist();return true;
  }
  async function request(path,options={}){
    const response=await fetch(config.url+'/rest/v1/'+path,{...options,headers:{apikey:config.key,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000),cache:'no-store'});
    if(!response.ok)throw Error('云端请求失败（'+response.status+'）');
    return response.status===204?null:response.json();
  }
  async function sync(){
    if(!Cloud.profile||Cloud.busy)return;
    const profile=Cloud.profile,pack=Cloud.pack;Cloud.busy=true;Cloud.message='正在同步…';status();
    try{
      const pending=pack.pending.slice(0,100);
      Cloud.inFlight=new Set(pending.map(e=>e.id));
      if(pending.length)await request('rpc/caac_append_events',{method:'POST',body:JSON.stringify({p_profile:profile,p_events:pending})});
      let count;
      do{
        const events=await request('caac_events?profile_id=eq.'+encodeURIComponent(profile)+'&seq=gt.'+pack.cursor+'&order=seq.asc&limit=1000');
        if(Cloud.profile!==profile||Cloud.pack!==pack)return;
        count=events.length;
        for(const event of events){
          if(!pack.seen[event.id]){try{apply(pack.base,event);}catch(error){Cloud.diagnostics.push({seq:event.seq,kind:event.kind,error:String(error)});Cloud.problem='有一条云端资料格式无效，已跳过；现有答题记录保留。';}pack.seen[event.id]=event.seq;}
          pack.cursor=Math.max(pack.cursor,Number(event.seq));
        }
      }while(count===1000);
      pack.pending=pack.pending.filter(e=>!pack.seen[e.id]);
      const active=view==='quiz'?state.session:null,activeExam=view==='exam'?state.exams?.active:null;
      const before=JSON.stringify({records:state.records,prefs:state.prefs,picked:state.picked,exams:state.exams,session:state.session});
      state=projected();
      // An active device keeps its current question while all devices merge their answer records.
      if(active){if(state.session?.uid===active.uid)active.results={...state.session.results,...active.results};state.session=active;}
      if(activeExam){state.exams||={history:[]};const submitted=state.exams.history?.some(x=>x.id===activeExam.id);if(!submitted)state.exams.active=activeExam;else if(view==='exam')view='exam-result';}
      remember();persist();Cloud.lastSync=Date.now();Cloud.message=pack.pending.length?'仍有 '+pack.pending.length+' 项等待同步':'已保存到云端';
      if(before!==JSON.stringify({records:state.records,prefs:state.prefs,picked:state.picked,exams:state.exams,session:state.session}))render();
    }catch(error){if(Cloud.profile===profile){Cloud.diagnostics.push({syncError:String(error)});Cloud.message='暂未连上云端 · 本机待传 '+pack.pending.length+' 项';}}
    finally{Cloud.inFlight.clear();Cloud.busy=false;status();if(Cloud.profile!==profile)Cloud.ready=sync();else if(Cloud.pack?.pending.length&&navigator.onLine&&Cloud.message.startsWith('仍有 '))Cloud.timer=setTimeout(sync,250);}
  }
  async function selectProfile(id){
    if(!profiles.some(p=>p[0]===id)&&id!=='')return;
    const wasTiming=clock.start!==null;clock.settle();if(Cloud.profile||wasTiming)save();stopMedia();
    let pack;
    try{if(id){const raw=localStorage.getItem(cacheKey(id));pack=raw?JSON.parse(raw):freshPack();if(!pack.base||!Array.isArray(pack.pending))throw Error('缓存格式有误');pack.base=E.validate(pack.base,{allowSession:true});pack.seen||={};}}
    catch{toast('该用户本机缓存无法读取，原文件未覆盖，请先导出备份。');return;}
    Cloud.profile=id||null;Cloud.pack=pack||null;Cloud.problem='';
    try{localStorage.setItem(chosenKey,id);}catch{}
    if(id)state=projected();else{try{state=E.validate(JSON.parse(localStorage.getItem(E.key)||JSON.stringify(E.fresh())),{allowSession:true});}catch{state=E.fresh();}}
    view='home';tab='chapters';selected=null;writeBlocked=false;storageError='';remember();Cloud.message=id?'正在读取该用户云端记录…':'未选择用户 · 本机进度';render();Cloud.ready=sync();await Cloud.ready;
  }
  function status(){
    const el=document.querySelector('#cloud-status');if(!el)return;
    el.textContent=Cloud.problem||Cloud.message;
    el.dataset.state=Cloud.problem?'error':Cloud.pack?.pending.length?'pending':Cloud.lastSync?'saved':'local';
  }
  function panel(){
    const name=profiles.find(p=>p[0]===Cloud.profile)?.[1]||'本机访客';
    let legacy=0;try{legacy=Object.keys(JSON.parse(localStorage.getItem(E.key)||'{}').records||{}).length;}catch{}
    return `<section class="cloud-panel"><div><label for="study-profile"><strong>当前用户</strong></label><select id="study-profile"><option value="">本机访客</option>${profiles.map(([id,name])=>`<option value="${id}" ${Cloud.profile===id?'selected':''}>${name}</option>`).join('')}</select><span id="cloud-status" role="status"></span></div><div class="actions"><button class="btn small outline" data-text-backup="copy">复制进度备份</button><button class="btn small outline" data-text-backup="restore">粘贴恢复</button>${Cloud.profile?'<button class="btn small outline" data-v2="sync">立即同步</button>':''}${Cloud.profile&&legacy?`<button class="btn small outline" data-v2="migrate">导入本机旧进度（${legacy}题）</button>`:''}</div><p class="small muted">${Cloud.profile?escape(name)+'的记录在手机、平板和电脑间同步。':'不选姓名时只保存本机。'} 三位用户互相独立；按约定只选姓名，无密码保护。</p></section>`;
  }
  save=capture;
  E.register=(target,id,answer,options={})=>{
    const result=register(target,id,answer,options);
    if(target===state&&Cloud.profile){queue('answer',{id,answer,at:options.at||Date.now(),day:options.day||E.today(),elapsedMs:options.elapsedMs,sessionId:state.session?.uid});Cloud.recordsSnapshot=JSON.stringify(state.records);}
    return result;
  };
  function migrate(){
    if(!Cloud.profile)return;
    try{const raw=localStorage.getItem(E.key);if(!raw)return;const imported=E.validate(JSON.parse(raw),{allowSession:true});if(!confirm('将本机旧记录合并到'+profiles.find(p=>p[0]===Cloud.profile)[1]+'？重叠题目保留提交次数较多的记录，原本机记录仍保留。'))return;queue('seed',{state:imported});state=projected();remember();persist();render();sync();toast('旧记录已加入同步队列。');}catch(error){toast('导入失败：'+error.message);}
  }
  const clock={key:null,start:null,session:null,id:null,kind:null,
    settle(){if(this.start===null||!this.session)return;const ms=Math.max(0,performance.now()-this.start);this.session.timeSpent||={};this.session.timeSpent[this.id]=(this.session.timeSpent[this.id]||0)+ms;this.start=null;},
    arm(){
      let s,id,kind;
      if(view==='quiz'&&state.session){s=state.session;id=s.ids[s.index];kind='quiz';if(s.results[id])s=null;}
      else if(view==='exam'&&state.exams?.active){s=state.exams.active;id=s.ids[s.index];kind='exam';}
      const key=s?kind+':'+(s.uid||s.id)+':'+id:null;
      if(key!==this.key){this.settle();this.key=key;this.session=s;this.id=id;this.kind=kind;}
      if(s&&!document.hidden&&this.start===null)this.start=performance.now();
    },
    elapsed(){this.settle();const n=this.session?.timeSpent?.[this.id]||0;return Math.round(n);}
  };
  const tier=ms=>ms<20000?'low':ms<=40000?'medium':'high';
  const tierNames={low:'低档 · 立即完成',medium:'中档 · 思考完成',high:'高档 · 较有难度'};
  function timingIds(level){return allIds.filter(id=>{const t=state.records[id]?.timing;return t?.count>0&&tier(t.lastMs)===level;});}
  function timingMarkup(){
    return `<section class="feature-section"><h2>按做题用时专项练习</h2><p class="small muted">按你最近一次作答的前台有效用时分档，不等同于题目客观难度；答错的快题仍会进入错题本。20秒以下为低档，20–40秒为中档，超过40秒为高档。旧记录无计时，不强行归档。</p><div class="timing-grid">${['low','medium','high'].map(level=>{const ids=timingIds(level);return `<article><h3>${tierNames[level]}</h3><p>${ids.length} 题</p><button class="btn small" data-v2="timing" data-level="${level}" ${ids.length?'':'disabled'}>专项练习</button><button class="text-button" data-v2="timing-list" data-level="${level}">查看题目</button></article>`;}).join('')}</div></section>`;
  }
  let timingLevel='high';
  function timingList(){const ids=timingIds(timingLevel);return `<section class="feature-section"><button class="btn small outline" data-action="home">返回首页</button><h1>${tierNames[timingLevel]}</h1><p>共 ${ids.length} 题，按最近一次作答用时分类。</p>${ids.map(id=>{const q=questions.get(id),r=state.records[id];return `<article class="timing-row"><div><span class="badge">${escape(chapterName(q.chapterId))} · ${(r.timing.lastMs/1000).toFixed(1)}秒 · ${r.lastCorrect?'答对':'答错'}</span><p>${escape(plain(q.question))}</p></div><button class="btn small" data-action="single" data-id="${id}">做这题</button></article>`;}).join('')||'<p>暂未积累本档计时记录。</p>'}</section>`;}
  function validateExam(raw){
    if(!raw)return null;
    if(typeof raw.id!=='string'||!Array.isArray(raw.ids)||raw.ids.length!==100||new Set(raw.ids).size!==100||!raw.ids.every(id=>questions.has(id))||!Number.isFinite(raw.deadline)||!Number.isInteger(raw.index)||raw.index<0||raw.index>=100)return null;
    for(const id of raw.ids){const codes=questions.get(id).answers.map(a=>a.answerCode),given=raw.optionOrder?.[id];if(!Array.isArray(given)||given.length!==codes.length||new Set(given).size!==codes.length||!given.every(c=>codes.includes(c)))return null;}
    return raw;
  }
  function validateResult(r){return r&&typeof r.id==='string'&&Array.isArray(r.ids)&&r.ids.length===100&&r.ids.every(id=>questions.has(id))&&Number.isFinite(r.finishedAt);}
  function shuffled(items){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
  function examHub(){
    const history=state.exams?.history||[],active=validateExam(state.exams?.active);
    return `<section class="feature-section exam-hub"><h2>模拟考试</h2><p>120分钟 · 随机100道单选题 · 每题1分 · 80分合格</p><p class="small muted">每次抽题与选项顺序随机；交卷前不显示正误、技巧和视频。练习规则，不代表考场当前官方配置。截止时间按自然时间计算，切后台仍继续倒计时。</p><div class="actions"><button class="btn primary" data-v2="exam-start">开始模拟考试</button>${active?'<button class="btn outline" data-v2="exam-resume">继续未交卷考试</button>':''}</div>${history.length?`<h3>最近考试</h3>${[...history].sort((a,b)=>b.finishedAt-a.finishedAt).slice(0,5).map(r=>`<button class="exam-history" data-v2="exam-result" data-id="${escape(r.id)}"><span>${escape(new Date(r.finishedAt).toLocaleString('zh-CN'))}</span><strong>${r.correct}分 · ${r.correct>=80?'合格':'待提升'}</strong></button>`).join('')}`:''}</section>`;
  }
  let resultId=null,submittingExam=false;
  function startExam(){
    if(state.exams?.active&&!confirm('已有未交卷考试。是否新开一场？原未交卷试卷将被替换，不计入成绩。'))return;
    clock.settle();stopMedia();const ids=shuffled(allIds).slice(0,100),optionOrder={};for(const id of ids)optionOrder[id]=shuffled(questions.get(id).answers.map(a=>a.answerCode));
    state.exams||={active:null,history:[]};state.exams.active={id:uuid(),ids,index:0,answers:{},optionOrder,timeSpent:{},startedAt:Date.now(),deadline:Date.now()+120*60000};save();view='exam';render();window.scrollTo(0,0);
  }
  const remaining=exam=>Math.max(0,Math.ceil((exam.deadline-Date.now())/1000));
  const timeText=n=>Math.floor(n/60).toString().padStart(2,'0')+':'+(n%60).toString().padStart(2,'0');
  function examMarkup(){
    const exam=validateExam(state.exams?.active);if(!exam){view='home';return homeMarkup();}
    const id=exam.ids[exam.index],q=questions.get(id),answers=exam.answers||{},order=exam.optionOrder[id];
    return `<header class="quiz-head"><button class="btn small outline" data-v2="exam-home">暂存并返回首页</button><h2>模拟考试 · 第 ${exam.index+1} / 100 题</h2><span class="exam-clock" id="exam-countdown">${timeText(remaining(exam))}</span></header><div class="quiz-layout"><main class="question-panel"><span class="badge">单选题 · ${escape(chapterName(q.chapterId))}</span><h1 class="question-title">${questionCue(q.question)}</h1>${safeUrl(q.questionImg)?`<img class="question-image" src="${escape(q.questionImg)}" alt="题目配图">`:''}<div class="options">${order.map((code,i)=>{const a=q.answers.find(a=>a.answerCode===code);return `<button class="option ${answers[id]===code?'selected':''}" data-v2="exam-answer" data-code="${escape(code)}" aria-pressed="${answers[id]===code}"><span class="letter">${String.fromCharCode(65+i)}</span><span>${escape(plain(a.answer))}${safeUrl(a.answerImg)?`<img src="${escape(a.answerImg)}" alt="选项配图">`:''}</span></button>`;}).join('')}</div><p class="small muted">选择即保存，可修改答案；交卷后统一判分。</p><div class="quiz-controls"><button class="btn outline" data-v2="exam-prev" ${exam.index===0?'disabled':''}>上一题</button><button class="btn primary" data-v2="exam-next" ${exam.index===99?'disabled':''}>下一题</button></div></main><aside class="quiz-aside"><h3>已选 ${Object.keys(answers).length} / 100 题</h3><div class="palette">${exam.ids.map((id,i)=>`<button class="${i===exam.index?'current ':''}${answers[id]?'chosen-exam':''}" data-v2="exam-jump" data-index="${i}">${i+1}</button>`).join('')}</div><p class="small muted">蓝色表示已选择，不代表正确。到时自动交卷；刷新页面不会重置倒计时。</p><button class="btn primary" data-v2="exam-submit">交卷并查看分析</button></aside></div>`;
  }
  function deterministicId(text){let a=2166136261,b=2246822519,c=3266489917,d=668265263;for(const ch of text){const n=ch.charCodeAt(0);a=Math.imul(a^n,16777619);b=Math.imul(b^n,3266489917);c=Math.imul(c^n,668265263);d=Math.imul(d^n,374761393);}const h=[a,b,c,d].map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
  function finishExam(automatic=false){
    const exam=validateExam(state.exams?.active);if(!exam||submittingExam)return;
    const missing=100-Object.keys(exam.answers||{}).length;
    if(!automatic&&!confirm('确认交卷？'+(missing?'还有'+missing+'题未答，按错误计入本次100题成绩。':'')))return;
    submittingExam=true;clock.settle();stopMedia();
    state.exams||={active:null,history:[]};
    if(state.exams.history.some(x=>x.id===exam.id)){resultId=exam.id;state.exams.active=null;view='exam-result';submittingExam=false;render();return;}
    const result={...clone(exam),finishedAt:Date.now(),correct:0,missing,automatic};
    for(const id of exam.ids){const code=exam.answers[id];if(!code)continue;const right=questions.get(id).answers.some(a=>a.answerCode===code&&a.isRight);result.correct+=Number(right);const options={at:result.finishedAt,day:E.today(),elapsedMs:Math.round(exam.timeSpent[id]||0)};
      if(Cloud.profile){const eventId=deterministicId(exam.id+':answer:'+id);if(!Cloud.pack.seen[eventId]&&!Cloud.pack.pending.some(e=>e.id===eventId)){register(state,id,code,options);queue('answer',{id,answer:code,...options},eventId);}}
      else register(state,id,code,options);
    }
    state.exams.history.push(result);state.exams.active=null;
    if(Cloud.profile){Cloud.recordsSnapshot=JSON.stringify(state.records);queue('exam',{result},deterministicId(exam.id+':result'));}
    resultId=result.id;save();view='exam-result';submittingExam=false;render();sync();window.scrollTo(0,0);
  }
  function examResultMarkup(){
    const history=state.exams?.history||[],r=history.find(x=>x.id===resultId)||[...history].sort((a,b)=>b.finishedAt-a.finishedAt)[0];
    if(!r){view='home';return homeMarkup();}
    const rows=bank.chapters.map(ch=>{const ids=r.ids.filter(id=>questions.get(id).chapterId===ch.id);const right=ids.filter(id=>questions.get(id).answers.some(a=>a.answerCode===r.answers[id]&&a.isRight)).length;return {...ch,ids,right,wrong:ids.length-right,accuracy:ids.length?right/ids.length*100:null};}).filter(x=>x.ids.length);
    const weak=rows.filter(x=>x.wrong).sort((a,b)=>b.wrong-a.wrong||(a.accuracy-b.accuracy));
    const wrong=r.ids.filter(id=>!questions.get(id).answers.some(a=>a.answerCode===r.answers[id]&&a.isRight));
    return `<section class="feature-section"><button class="btn outline small" data-action="home">返回首页</button><p class="eyebrow">模拟考试结果 · 已保存</p><h1>${r.correct} / 100 分 · ${r.correct>=80?'合格':'需要继续巩固'}</h1><p>未答 ${r.missing} 题 · ${r.automatic?'到时自动交卷':'主动交卷'} · 合格线80分</p><h2>建议补足的板块</h2>${weak.length?weak.map((ch,i)=>`<article class="timing-row"><div><strong>${i+1}. ${escape(ch.name)}</strong><p>本次 ${ch.ids.length} 题，答对 ${ch.right}，错题或未答 ${ch.wrong}；正确率 ${percent(ch.accuracy)}。${ch.ids.length<5?'样本较少，仅供复习参考。':''}</p></div><button class="btn small" data-v2="exam-weak" data-result="${escape(r.id)}" data-chapter="${ch.id}">补足本板块</button></article>`).join(''):'<p>本次全部答对，可复习高用时题和历史错题。</p>'}<div class="table-scroll"><table><thead><tr><th>章节</th><th>抽到题数</th><th>正确</th><th>错／未答</th><th>正确率</th></tr></thead><tbody>${rows.map(ch=>`<tr><td>${escape(ch.name)}</td><td>${ch.ids.length}</td><td>${ch.right}</td><td>${ch.wrong}</td><td>${percent(ch.accuracy)}</td></tr>`).join('')}</tbody></table></div><h2>本次错题与未答题</h2><p class="small muted">未答题纳入本次考试分析，不伪造一次日常作答；已答错题会进入错题本。</p>${wrong.map(id=>{const q=questions.get(id),order=r.optionOrder[id];const code=r.answers[id],position=order.indexOf(code);return `<details class="exam-review"><summary>${escape(plain(q.question))}</summary><p>你的选择：${code?String.fromCharCode(65+position)+'. '+escape(plain(q.answers.find(a=>a.answerCode===code).answer)):'未答'}</p><p>正确答案：${q.answers.filter(a=>a.isRight).map(a=>String.fromCharCode(65+order.indexOf(a.answerCode))+'. '+escape(plain(a.answer))).join('；')}</p><h3>答题技巧与解析</h3>${formattedStudyText(q.analysis,'暂无答题技巧。')}${formattedStudyText(q.txtExplain,'暂无文字解析。')}${courseQuestionMarkup(id)}<button class="btn small" data-action="single" data-id="${id}">重新练习这题</button></details>`;}).join('')||'<p>没有错题。</p>'}</section>`;
  }
  function ensureSession(){if(state.session&&!state.session.uid)state.session.uid=uuid();}
  // Extend the original practice flow; keep its question IDs, progress key and answer content unchanged.
  const oldStart=start;start=function(...args){clock.settle();oldStart(...args);ensureSession();save();clock.arm();};
  const oldSubmit=submit;submit=function(){if(!state.session||state.session.results[state.session.ids[state.session.index]]||!selected)return;ensureSession();const elapsedMs=clock.elapsed();const fn=E.register;E.register=(s,id,code,options)=>fn(s,id,code,{...options,elapsedMs});try{oldSubmit();}finally{E.register=fn;}clock.arm();};
  for(const name of ['next','finish','returnHome']){
    const fn={next,finish,returnHome}[name];const wrapped=function(...args){clock.settle();const result=fn(...args);clock.arm();return result;};if(name==='next')next=wrapped;else if(name==='finish')finish=wrapped;else returnHome=wrapped;
  }
  render=function(){
    ensureSession();
    if(view==='exam')$('#app').innerHTML=examMarkup();else if(view==='exam-result')$('#app').innerHTML=examResultMarkup();else if(view==='timing')$('#app').innerHTML=timingList();else oldRender();
    $('#app').insertAdjacentHTML('afterbegin',panel());status();
    if(view==='home'){const hero=$('#app .hero');if(hero)hero.insertAdjacentHTML('afterend',timingMarkup()+examHub());const line=$('.statusline');if(line)line.textContent=Cloud.profile?'按姓名分开记录 · 支持多设备云端同步':'本机访客记录 · 选择姓名后启用云端同步';}
    clock.arm();
  };
  document.addEventListener('change',event=>{if(event.target.id==='study-profile')selectProfile(event.target.value);});
  document.addEventListener('click',event=>{
    const v=event.target.closest('[data-v2]');if(!v||v.disabled)return;
    const action=v.dataset.v2;
    if(action==='sync')sync();else if(action==='migrate')migrate();
    else if(action==='timing')start(timingIds(v.dataset.level),tierNames[v.dataset.level]+' · 用时专项','smart');
    else if(action==='timing-list'){clock.settle();timingLevel=v.dataset.level;view='timing';render();}
    else if(action==='exam-start')startExam();
    else if(action==='exam-resume'){view='exam';render();if(remaining(state.exams.active)<=0)finishExam(true);}
    else if(action==='exam-home'){clock.settle();save();view='home';render();}
    else if(action==='exam-answer'){
      const exam=state.exams?.active;if(!exam)return;if(remaining(exam)<=0){finishExam(true);return;}
      clock.settle();exam.answers[exam.ids[exam.index]]=v.dataset.code;save();render();
    }else if(['exam-prev','exam-next','exam-jump'].includes(action)){
      clock.settle();const exam=state.exams?.active;if(!exam)return;exam.index=action==='exam-jump'?Number(v.dataset.index):Math.max(0,Math.min(99,exam.index+(action==='exam-next'?1:-1)));save();render();window.scrollTo(0,0);
    }else if(action==='exam-submit')finishExam();
    else if(action==='exam-result'){resultId=v.dataset.id;view='exam-result';render();}
    else if(action==='exam-weak'){
      const r=state.exams.history.find(x=>x.id===v.dataset.result),ids=r.ids.filter(id=>questions.get(id).chapterId===v.dataset.chapter&&!questions.get(id).answers.some(a=>a.answerCode===r.answers[id]&&a.isRight));start(ids,chapterName(v.dataset.chapter)+' · 模考补足','smart');
    }
  });
  // Freeze active timing before original navigation/peek handlers run.
  document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(el&&['prev','jump','peek','home','finish','skip','next'].includes(el.dataset.action)){clock.settle();}},true);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clock.settle();save();}else{clock.arm();sync();}});
  window.addEventListener('pagehide',()=>{clock.settle();save();});
  window.addEventListener('online',sync);window.addEventListener('focus',sync);
  window.addEventListener('storage',event=>{if(event.key===chosenKey&&event.newValue!==Cloud.profile){Cloud.message='另一标签页选择了其他用户，本页仍保持当前用户';status();}if(event.key===cacheKey(Cloud.profile)){sync();}});
  document.addEventListener('keydown',event=>{
    if(view!=='exam'||event.altKey||event.ctrlKey||event.metaKey||event.repeat||['INPUT','SELECT','TEXTAREA','BUTTON'].includes(event.target.tagName))return;
    if(/^[1-4]$/.test(event.key)){const exam=state.exams.active,code=exam.optionOrder[exam.ids[exam.index]][Number(event.key)-1];if(code){event.preventDefault();document.querySelector(`[data-v2="exam-answer"][data-code="${code}"]`)?.click();}}
  });
  setInterval(()=>{if(view==='exam'&&state.exams?.active){const seconds=remaining(state.exams.active),el=$('#exam-countdown');if(el)el.textContent=timeText(seconds);if(seconds<=0)finishExam(true);}else if(state.exams?.active&&remaining(state.exams.active)<=0)finishExam(true);},1000);
  setInterval(()=>{if(clock.start!==null){clock.settle();if(Cloud.profile){Cloud.pack.localTiming={id:clock.session.uid||clock.session.id,kind:clock.kind,question:clock.id,ms:clock.session.timeSpent?.[clock.id]||0};persist();}else save();clock.arm();}},5000);
  setInterval(sync,8000);
  let previous='';try{previous=localStorage.getItem(chosenKey)||'';}catch{}
  remember();render();if(previous)Cloud.ready=selectProfile(previous);
  async function mergeBackup(imported,target){
    clock.settle();
    if((Cloud.profile||'')!==target)await selectProfile(target);
    if((Cloud.profile||'')!==target)throw Error('未能切换到指定用户，未导入任何记录');
    if(Cloud.profile){queue('seed',{state:E.validate(imported,{allowSession:true})});state=projected();remember();persist();view='home';save();render();await sync();}
    else{apply(state,{kind:'seed',payload:{state:imported}});view='home';save();render();}
  }
  return {Cloud,clock,tier,timingIds,selectProfile,sync,startExam,finishExam,validateExam,projected,deterministicId,mergeBackup};
})();
