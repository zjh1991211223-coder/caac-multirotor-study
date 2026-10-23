const E = StudyEngine, { bank, questions } = E;
const allIds = [...questions.keys()];
const chapterIds = id => bank.questions.filter(q => q.chapterId === id).map(q => q.id);
const $ = (s, root = document) => root.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain = value => {
  const d = document.createElement('div');
  d.innerHTML = String(value || '').replace(/<\s*(br|p|div|li)\b[^>]*>/gi, '\n');
  return d.textContent.replace(/\u00a0/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
};
const safeUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
};
const questionCue = text => escape(plain(text)).replace(/(不属于|不正确|不包括|不包含|不需要|不适宜|不可以|不能|不宜|不应|错误|除外|无需|不得|严禁)/g,'<mark class="question-cue">$1</mark>');
const formattedStudyText = (value, fallback) => {const text=plain(value)||fallback;return text.split(/\n\s*\n/).map(block=>'<p>'+escape(block).replace(/\n/g,'<br>')+'</p>').join('');};
const correctAnswerContents = q => q.answers.filter(a=>a.isRight).map(a=>escape(a.answerCode)+'. '+escape(plain(a.answer))).join('；');
const percent = value => value === null ? '—' : value.toFixed(1) + '%';
const chapterName = id => bank.chapters.find(c => c.id === id)?.name || '章节';
let state = E.fresh(), storageError = '', view = 'home', tab = 'chapters', selected = null, autoTimer = null;
let wrongChapter = 'all', wrongFilter = 'pending', wrongSort = 'priority', wrongPage = 0;
let searchText = '', toastTimer, summaryData = null;
try {
  const stored = localStorage.getItem(E.key);
  if (stored) state = E.validate(JSON.parse(stored), { allowSession: true });
} catch (error) { storageError = '未能读取本机进度：' + error.message + '。原存储不会被自动覆盖，请先备份。'; }
let writeBlocked = !!storageError;
function toast(text) {
  clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false;
  toastTimer = setTimeout(() => $('#toast').hidden = true, 3200);
}
function save() {
  if (writeBlocked) { showStorageNotice(); return false; }
  try {
    localStorage.setItem(E.key, JSON.stringify(state)); storageError = ''; return true;
  } catch (error) {
    storageError = '浏览器无法保存进度。本次作答暂存在当前页面，请立即导出备份，关闭页面可能丢失。';
    showStorageNotice(); return false;
  }
}
function showStorageNotice() {
  $('#storage-notice').hidden = !storageError;
  $('#storage-notice').textContent = storageError;
}
function stopMedia() {
  clearTimeout(autoTimer); autoTimer = null;
  document.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
}
function metrics(ids = allIds) { return E.stats(ids, state); }
function isPending(id) { const r = state.records[id]; return r?.wrong > 0 && r.streak < 2; }
function isRepeated(id) { return isPending(id) && state.records[id].wrong >= 2; }
function filteredScope(ids, scope) {
  return ids.filter(id => scope === 'wrong' ? isPending(id) : scope === 'unseen' ? !state.records[id]?.attempts : true);
}
function start(ids, title, mode = 'smart', limit = 0) {
  if (!ids.length) { toast('当前范围没有可练习的题目，请调整选择。'); return; }
  stopMedia(); selected = null;
  const ordered = E.order(ids, mode, state);
  state.session = { ids: limit ? ordered.slice(0, limit) : ordered, title, index: 0, mode, results: {} };
  save(); view = 'quiz'; render(); window.scrollTo(0, 0);
}
function startPlan() {
  const p = state.prefs;
  start(filteredScope(allIds.filter(id => p.chapters.includes(questions.get(id).chapterId)), p.scope), '我的定制练习', p.order, p.limit);
}
function startChapter(id, mode = 'original') {
  start(chapterIds(id), chapterName(id) + ' · ' + (mode === 'original' ? '顺序练习' : '智能练习'), mode);
}
function returnHome(newTab) {
  stopMedia(); if (newTab) tab = newTab; view = 'home'; selected = null; render(); window.scrollTo(0, 0);
}
function card(c) {
  const m = metrics(chapterIds(c.id));
  return `<section class="chapter" data-chapter="${c.id}"><div class="heading"><h3><span class="number">${String(c.order).padStart(2,'0')}</span>${escape(c.name)}</h3><button class="practice" data-action="chapter" data-id="${c.id}">顺序练习</button></div><div class="chapter-metrics"><span><strong>${m.attempted}</strong>/${m.total}</span><span>正确率 ${percent(m.accuracy)}</span>${m.wrong ? `<span class="tag">${m.wrong} 题待巩固</span>` : ''}</div><div class="bar" role="progressbar" aria-label="${escape(c.name)}答题进度" aria-valuemin="0" aria-valuemax="${m.total}" aria-valuenow="${m.attempted}"><span style="width:${m.attempted/m.total*100}%"></span></div><div class="chapter-bottom"><span>${m.submissions ? `累计提交 ${m.submissions} 次 · 答对 ${m.correct} 次` : '尚未作答，从第一题开始'}</span><button class="text-button" data-action="chapter-smart" data-id="${c.id}">智能顺序 →</button></div></section>`;
}
function recommendationMarkup() {
  const items = bank.chapters.map(c => ({...c, m: metrics(chapterIds(c.id))}));
  const weak = items.filter(c => c.m.wrong > 0).sort((a,b) => b.m.wrong/b.m.total-a.m.wrong/a.m.total || b.m.wrong-a.m.wrong).slice(0,3);
  const chosen = weak.length ? weak : items.filter(c => c.m.attempted < c.count).sort((a,b) => a.order-b.order).slice(0,1);
  if (!chosen.length) return `<div class="empty"><h3>全部题目已覆盖，当前没有待巩固错题</h3><p class="muted">可以随机复习，再检查一次对知识点的掌握。</p><button class="btn small" data-action="random-review">随机复习 30 题</button></div>`;
  return `<div class="recommendations">${chosen.map((c,i) => `<section class="recommend"><div class="rank">${weak.length ? `攻坚建议 ${String(i+1).padStart(2,'0')}` : '开始前的建议'}</div><h3>${escape(c.name)}</h3><p>${weak.length ? `${c.m.wrong} 题待巩固 · 已答 ${c.m.attempted}/${c.count} 题${c.m.submissions < 5 ? '，作答样本较少' : ` · 正确率 ${percent(c.m.accuracy)}`}` : '还没有足够的作答记录，先做 10 题建立自己的薄弱点画像。'}</p><button class="btn small" data-action="recommend" data-id="${c.id}" data-weak="${!!weak.length}">${weak.length ? '专项攻坚' : '开始 10 题诊断'} →</button></section>`).join('')}</div>`;
}
function planMarkup() {
  const p = state.prefs;
  return `<details id="plan-panel" class="plan-panel"><summary>个人练习设置 <span class="muted small">选择章节、题目范围、顺序与解析内容</span></summary><div class="plan-body"><div class="section-head"><h3>想练哪些章节？</h3><div class="actions"><button class="text-button" data-action="chapters-all">全选</button><button class="text-button" data-action="chapters-none">清空选择</button></div></div><div class="chapter-picks">${bank.chapters.map(c=>`<label><input type="checkbox" data-pref-chapter="${c.id}" ${p.chapters.includes(c.id)?'checked':''}> ${String(c.order).padStart(2,'0')} ${escape(c.name)} <small>${c.count}</small></label>`).join('')}</div><div class="plan-controls"><label>题目范围<select data-pref="scope"><option value="all" ${p.scope==='all'?'selected':''}>全部题目</option><option value="unseen" ${p.scope==='unseen'?'selected':''}>仅未答题</option><option value="wrong" ${p.scope==='wrong'?'selected':''}>仅待巩固错题</option></select></label><label>题目顺序<select data-pref="order"><option value="smart" ${p.order==='smart'?'selected':''}>智能：错题 → 未答 → 已答</option><option value="original" ${p.order==='original'?'selected':''}>原题顺序</option><option value="random" ${p.order==='random'?'selected':''}>随机顺序</option></select></label><label>每轮题数<select data-pref="limit">${[[10,'10 题'],[20,'20 题'],[30,'30 题'],[0,'全部所选题']].map(([v,n])=>`<option value="${v}" ${p.limit===v?'selected':''}>${n}</option>`).join('')}</select></label></div><div class="content-picks"><strong>答错后自动显示</strong>${[['tips','答题技巧'],['explanation','文字解析'],['video','解析视频']].map(([k,n])=>`<label><input type="checkbox" data-pref="${k}" ${p[k]?'checked':''}> ${n}</label>`).join('')}<label><input type="checkbox" data-pref="autoNext" ${p.autoNext?'checked':''}> 答对自动下一题</label></div><p class="small muted">智能顺序依据你自己的错题记录排序，优先反复错题，再练未答题；不改变原题内容或答案。看过答案的题本轮不计分。</p><div class="actions" style="margin-top:16px"><button class="btn primary" data-action="start-plan">开始我的练习</button><span class="small muted" id="plan-count"></span></div></div></details>`;
}
function searchMarkup() {
  return `<div class="searchbar"><input id="question-search" type="search" placeholder="搜题干、选项、答题技巧… 可单独勾选想练的题" value="${escape(searchText)}" aria-label="搜索题库"><button class="btn outline" data-action="picked">自选题篮 <span id="picked-count">${state.picked.length}</span></button></div><div id="search-results" class="search-results"></div>`;
}
function renderSearch() {
  const root = $('#search-results'); if (!root) return;
  if (!searchText.trim()) { root.innerHTML=''; return; }
  const text=searchText.trim().toLowerCase();
  const hits = bank.questions.filter(q => [q.question,q.analysis,q.txtExplain,...q.answers.map(a=>a.answer)].some(t=>plain(t).toLowerCase().includes(text)));
  root.innerHTML=`<div class="section-head small"><span class="muted">找到 ${hits.length} 题${hits.length>25?'，先显示前 25 题':''}</span>${hits.length?'<button class="btn small" data-action="search-practice">练习全部匹配题</button>':''}</div>`+hits.slice(0,25).map(q=>`<div class="result-row"><div><span class="badge">${escape(chapterName(q.chapterId))}</span><h3>${escape(plain(q.question))}</h3></div><div class="actions"><label class="small"><input type="checkbox" data-pick="${q.id}" ${state.picked.includes(q.id)?'checked':''}> 自选</label><button class="btn small" data-action="single" data-id="${q.id}">做这题</button></div></div>`).join('');
}
function wrongIds() {
  return allIds.filter(id=>{
    const r=state.records[id];
    if(!r?.wrong) return false;
    if(wrongChapter!=='all'&&questions.get(id).chapterId!==wrongChapter)return false;
    return wrongFilter==='mastered'?r.streak>=2:wrongFilter==='repeated'?r.streak<2&&r.wrong>=2:wrongFilter==='all'?true:r.streak<2;
  }).sort((a,b)=>wrongSort==='recent'?state.records[b].lastAt-state.records[a].lastAt:state.records[b].wrong-state.records[a].wrong || state.records[a].streak-state.records[b].streak || state.records[a].lastAt-state.records[b].lastAt);
}
function wrongMarkup() {
  const ids=wrongIds(), limit=25, shown=ids.slice(wrongPage*limit,(wrongPage+1)*limit);
  const totalWrong=allIds.filter(id=>state.records[id]?.wrong>0).length;
  return `<div class="section-head"><div><h2>把错题变成得分点</h2><p class="muted small">错题连续两次答对后标记为已巩固；再答错会重新进入待巩固。</p></div><button class="btn primary" data-action="wrong-practice" ${ids.length?'':'disabled'}>专项练习当前 ${ids.length} 题</button></div><div class="filters"><select id="wrong-chapter" aria-label="错题章节"><option value="all">全部章节</option>${bank.chapters.map(c=>`<option value="${c.id}" ${wrongChapter===c.id?'selected':''}>${escape(c.name)}</option>`).join('')}</select><select id="wrong-filter" aria-label="错题状态">${[['pending','待巩固'],['repeated','反复出错'],['mastered','已巩固'],['all','全部历史错题']].map(([v,n])=>`<option value="${v}" ${wrongFilter===v?'selected':''}>${n}</option>`).join('')}</select><select id="wrong-sort" aria-label="错题排序"><option value="priority" ${wrongSort==='priority'?'selected':''}>反复错题优先</option><option value="recent" ${wrongSort==='recent'?'selected':''}>最近复习优先</option></select></div><p class="filter-summary">历史错题 ${totalWrong} 题 · 当前筛选 ${ids.length} 题 · ${metrics().mastered} 题已巩固</p>${ids.length?`<div class="wrong-list">${shown.map(id=>{
    const q=questions.get(id),r=state.records[id];
    return `<article class="wrong-item"><div><div class="wrong-meta"><span class="badge">${escape(chapterName(q.chapterId))}</span><span class="badge ${r.streak>=2?'mastered':r.wrong>=2?'hot':''}">${r.streak>=2?'已巩固':r.wrong>=2?'反复出错':'待巩固'}</span><span class="small muted">错 ${r.wrong} 次 · 连对 ${Math.min(r.streak,2)}/2 · 最近 ${escape(new Date(r.lastAt).toLocaleDateString('zh-CN'))}</span></div><h3>${escape(plain(q.question))}</h3></div><div class="actions"><label class="small"><input type="checkbox" data-pick="${id}" ${state.picked.includes(id)?'checked':''}> 自选</label><button class="btn small" data-action="single" data-id="${id}">重新做题</button></div></article>`;
  }).join('')}</div>${ids.length>limit?`<div class="actions" style="margin-top:20px"><button class="btn outline small" data-action="wrong-prev" ${wrongPage===0?'disabled':''}>上一页</button><span class="small muted">${wrongPage+1} / ${Math.ceil(ids.length/limit)}</span><button class="btn outline small" data-action="wrong-next" ${(wrongPage+1)*limit>=ids.length?'disabled':''}>下一页</button></div>`:''}`:`<div class="empty"><div class="symbol">✓</div><h3>${totalWrong?'当前筛选下没有题目':'错题本还是空的'}</h3><p class="muted">${totalWrong?'可以调整章节或查看已巩固的题目。':'开始练习后，答错的题会自动出现在这里。'}</p><button class="btn small" style="margin-top:16px" data-action="start-plan">开始练习</button></div>`}`;
}
function homeMarkup() {
  const m=metrics(), s=state.session;
  const daily=Object.values(state.records).reduce((n,r)=>n+(r.daily[E.today()]||0),0);
  return `<header class="topbar"><div class="identity"><div class="logo" aria-hidden="true">↗</div><div><p class="eyebrow">CAAC STUDY / 多旋翼</p><h1>超视距刷题训练台</h1><p class="statusline">${storageError?'进度保存异常':'进度自动保存在当前浏览器'} · 你和朋友的记录互不影响</p></div></div><div class="toolbar"><button class="btn outline small" data-action="export">备份进度 ↓</button><button class="btn outline small" data-action="import">恢复进度 ↑</button></div></header><section class="hero"><div><p class="eyebrow">你的练习，你来安排</p><h2>${s?'从上次停下的地方继续':'先过知识，再攻错题'}</h2><p>${s?`${escape(s.title)} · 第 ${s.index+1} / ${s.ids.length} 题`:'10 个章节，1,173 道题。自己选题、自己定顺序；答对自动下一题，答错当场看解析和视频。'}</p></div><div class="actions">${s?'<button class="btn primary" data-action="resume">继续练习 →</button>':'<button class="btn primary" data-action="start-plan">开始智能练习 →</button>'}<button class="btn outline" data-action="settings">自选题目与内容</button></div></section><div class="stats"><section class="stat"><p class="label">答题进度</p><p class="value" id="total-progress">${m.attempted}<small> / 1173</small></p><p class="hint">${(m.attempted/1173*100).toFixed(1)}% 的题目已覆盖</p></section><section class="stat"><p class="label">累计正确率</p><p class="value ${m.accuracy!==null&&m.accuracy>=80?'green':''}" id="total-accuracy">${percent(m.accuracy)}</p><p class="hint">${m.submissions?`答对 ${m.correct} / 提交 ${m.submissions} 次`:'开始答题后计算，不含提前看解析'}</p></section><section class="stat"><p class="label">待巩固错题</p><p class="value ${m.wrong?'red':''}" id="total-wrong">${m.wrong}<small> 题</small></p><p class="hint">${m.mastered} 题已连续两次答对</p></section><section class="stat"><p class="label">今日练习</p><p class="value" id="today-count">${daily}<small> 次</small></p><p class="hint">按当前设备日期统计</p></section></div>${planMarkup()}<div class="section-head"><div class="tabs" role="tablist" aria-label="练习区域"><button role="tab" aria-selected="${tab==='chapters'}" class="tab ${tab==='chapters'?'active':''}" data-action="tab-chapters">章节练习</button><button role="tab" aria-selected="${tab==='wrong'}" class="tab ${tab==='wrong'?'active':''}" data-action="tab-wrong">错题本 <span>${m.wrong}</span></button></div><span class="small muted">正确率 = 累计答对次数 ÷ 累计提交次数</span></div>${tab==='chapters'?`<section aria-label="攻坚建议">${recommendationMarkup()}</section><div class="section-head"><h2>按章节，稳步推进</h2><span class="small muted">10 个章节 · 1,173 题</span></div><div class="chapter-grid">${bank.chapters.map(card).join('')}</div><p class="explain-note">章节与题数按原题章节 ID 核对。智能练习优先待巩固错题，再练未答题；顺序练习保留原题顺序。</p>`:wrongMarkup()}${searchMarkup()}`;
}
function questionMarkup() {
  const s=state.session;
  if(!s){view='home';return homeMarkup();}
  const q=questions.get(s.ids[s.index]), result=s.results[q.id], r=state.records[q.id];
  const graded=!!result, revealed=graded;
  const answered=Object.values(s.results).filter(r=>!r.peek), correct=answered.filter(r=>r.right).length;
  return `<header class="quiz-head"><div class="row"><button class="btn outline small" data-action="home">← 返回章节</button><div><p class="label">${escape(s.title)}</p><h2>${escape(chapterName(q.chapterId))}</h2></div></div><span class="badge">${s.mode==='smart'?'智能顺序':s.mode==='random'?'随机练习':'原题顺序'}</span></header><div class="quiz-layout"><main class="question-panel"><div class="question-top"><span class="badge">单选题${r?.wrong?` · 历史错 ${r.wrong} 次`:''}</span><span class="question-count">第 <b id="quiz-index">${s.index+1}</b> / ${s.ids.length} 题 · 原题 ${q.order+1}</span></div><h1 class="question-title" id="question-title">${questionCue(q.question)}</h1>${safeUrl(q.questionImg)?`<img class="question-image" src="${escape(safeUrl(q.questionImg))}" alt="题目配图">`:''}<div class="options" role="group" aria-label="选择答案">${q.answers.map(a=>{
    const chosen=result?.answer===a.answerCode||(!graded&&selected===a.answerCode);
    return `<button class="option ${graded&&a.isRight?'correct':graded&&chosen&&!a.isRight?'incorrect':chosen?'selected':''}" data-action="answer" data-answer="${escape(a.answerCode)}" ${graded?'disabled':''} aria-pressed="${chosen}"><span class="letter">${escape(a.answerCode)}</span><span>${escape(plain(a.answer))}${safeUrl(a.answerImg)?`<img src="${escape(safeUrl(a.answerImg))}" alt="选项 ${escape(a.answerCode)} 配图" loading="lazy">`:''}</span></button>`;
  }).join('')}</div>${revealed?`<div id="answer-status" role="status" class="answer-status ${result.peek?'peek':result.right?'':'incorrect'}">${result.peek?'已查看解析，本题本轮不计入答题统计。':result.right?`回答正确，已计入本轮统计。`:`回答不正确。你选了 ${escape(result.answer)}，正确答案是 ${correctAnswerContents(q)}。已加入错题本。`}</div>`:''}<div class="quiz-controls"><div class="actions"><button class="btn outline" data-action="prev" ${s.index===0?'disabled':''}>上一题</button>${!graded?'<button class="btn ghost small" data-action="peek">先看解析，不计分</button>':''}</div><div class="actions">${!graded?`<button class="btn ghost" data-action="skip">跳过</button><span class="small muted">点击选项即提交</span>`:`<button class="btn primary" data-action="next">${s.index===s.ids.length-1?'完成本轮':'下一题 →'}</button>`}</div></div>${revealed?`<section class="analysis" aria-label="答案解析">${state.prefs.tips?`<div class="tips"><h3>答题技巧</h3><div class="content">${formattedStudyText(q.analysis,'该题暂无答题技巧。')}</div></div>`:''}${state.prefs.explanation?`<h3>文字解析</h3><div class="content">${formattedStudyText(q.txtExplain,'该题暂无文字解析。')}</div>`:''}${state.prefs.video?videoMarkup(q):''}<p class="muted small" style="margin-top:18px">资料按来源保留，未作专业正确性及法规时效复核。</p></section>`:''}</main><aside class="quiz-aside"><h3>本轮答题卡</h3><div class="session-metrics"><span><strong>${answered.length}/${s.ids.length}</strong>已提交</span><span><strong>${answered.length?percent(correct/answered.length*100):'—'}</strong>正确率</span></div><div class="bar" style="margin-bottom:18px"><span style="width:${answered.length/s.ids.length*100}%"></span></div><div class="palette">${s.ids.map((id,i)=>{const a=s.results[id];return `<button data-action="jump" data-index="${i}" class="${i===s.index?'current ':''}${a?a.peek?'read':a.right?'good':'bad':''}" aria-label="第 ${i+1} 题${a?a.peek?'，已看解析':a.right?'，答对':'，答错':''}" ${i===s.index?'aria-current="step"':''}>${i+1}</button>`}).join('')}</div><div class="legend"><span><i></i>正确</span><span><i class="bad"></i>错误</span><span><i class="read"></i>看过解析</span></div><div class="sidebar-note">选项快捷键：1–4，立即判题<br>同一轮每题只计分一次。错题复习时重新开一轮，记录新的结果。</div><button class="text-button" style="margin-top:16px" data-action="finish">提前结束本轮</button></aside></div>`;
}
function videoMarkup(q) {
  const url=safeUrl(q.videoExplain);
  return url?`<div class="video-box"><h3>视频解析</h3><button class="btn primary small" data-action="play">▶ 在线播放</button><video id="question-video" controls playsinline preload="none" hidden aria-label="本题视频解析" data-video="${escape(url)}"></video><p id="video-status" class="video-status" role="status"></p><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">备用：新窗口打开视频 ↗</a></div>`:'<p class="muted small" style="margin-top:20px">这道题没有视频，已显示来源提供的文字内容。</p>';
}
async function playVideo() {
  const v=$('#question-video');if(!v)return;
  const status=$('#video-status');v.hidden=false;
  if(!v.getAttribute('src'))v.src=v.dataset.video;
  status.textContent='正在加载视频…';
  v.onerror=()=>{if(document.contains(v))status.textContent='视频暂时无法播放，请重试或使用备用链接。';};
  v.onplaying=()=>{if(document.contains(v))status.textContent='';};
  try{await v.play();}catch(error){if(document.contains(v))status.textContent=error.name==='NotAllowedError'?'浏览器阻止了自动播放，请点击播放器或“在线播放”。':'视频暂时无法播放，请重试或使用备用链接。';}
}
function submit() {
  if(writeBlocked){toast('进度保存已暂停，请刷新页面或恢复有效备份后再答题。');return;}
  const s=state.session;if(!s)return;
  const id=s.ids[s.index];if(s.results[id]||!selected)return;
  s.results[id]=E.register(state,id,selected);
  save();render();
  if(s.results[id].right&&state.prefs.autoNext){autoTimer=setTimeout(()=>{if(state.session===s&&view==='quiz')next();},700);}
  else if(!s.results[id].right&&state.prefs.video)playVideo();
}
function next() {
  stopMedia();const s=state.session;if(!s)return;
  if(s.index===s.ids.length-1){finish();return;}
  s.index++;selected=null;save();render();window.scrollTo(0,0);
}
function finish() {
  stopMedia();const s=state.session;if(!s)return;
  const graded=Object.entries(s.results).filter(([,r])=>!r.peek);
  summaryData={title:s.title,total:s.ids.length,submitted:graded.length,correct:graded.filter(([,r])=>r.right).length,wrong:graded.filter(([,r])=>!r.right).map(([id])=>id),peek:Object.values(s.results).filter(r=>r.peek).length};
  state.session=null;save();view='summary';render();window.scrollTo(0,0);
}
function summaryMarkup() {
  const d=summaryData;
  if(!d){view='home';return homeMarkup();}
  return `<section class="summary"><div class="symbol">✓</div><p class="eyebrow">练习完成，记录已保存</p><h1>这一轮，又前进了一点</h1><p class="muted">${escape(d.title)} · 本轮 ${d.total} 题，提交 ${d.submitted} 题${d.peek?`，看解析 ${d.peek} 题`:''}</p><div class="summary-grid"><div><strong>${d.correct}</strong><span>答对题数</span></div><div><strong class="red">${d.wrong.length}</strong><span>本轮错题</span></div><div><strong>${d.submitted?percent(d.correct/d.submitted*100):'—'}</strong><span>本轮正确率</span></div></div><p class="muted small">错题至少再独立答对两次，才会进入已巩固。看过解析和跳过的题不计入正确率。</p><div class="actions">${d.wrong.length?'<button class="btn primary" data-action="retry-round">重练本轮错题</button>':''}<button class="btn outline" data-action="home">返回学习首页</button><button class="btn outline" data-action="open-wrong">打开错题本</button></div></section>`;
}
function render() {
  $('#app').innerHTML=view==='quiz'?questionMarkup():view==='summary'?summaryMarkup():homeMarkup();
  showStorageNotice();
  if(view==='home'){renderSearch();updatePlanCount();}
  if(view==='quiz'){const v=$('#question-video');if(v)v.addEventListener('error',()=>{const st=$('#video-status');if(st)st.textContent='视频暂时无法播放，请使用备用链接或重试。';});}
}
function updatePlanCount() {
  const n=filteredScope(allIds.filter(id=>state.prefs.chapters.includes(questions.get(id).chapterId)),state.prefs.scope).length;
  if($('#plan-count'))$('#plan-count').textContent=`范围内共 ${n} 题，本轮 ${state.prefs.limit?Math.min(n,state.prefs.limit):n} 题`;
}
function exportProgress() {
  const blob=new Blob([JSON.stringify({...state,session:null,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='CAAC-个人进度-'+E.today()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出个人进度备份。');
}
document.addEventListener('click',event=>{
  const el=event.target.closest('[data-action]');if(!el||el.disabled)return;
  const action=el.dataset.action,id=el.dataset.id;
  if(action==='chapter')startChapter(id);
  else if(action==='chapter-smart')startChapter(id,'smart');
  else if(action==='start-plan')startPlan();
  else if(action==='settings'){const d=$('#plan-panel');d.open=true;d.scrollIntoView({behavior:'smooth',block:'start'});}
  else if(action==='resume'){view='quiz';selected=null;render();window.scrollTo(0,0);}
  else if(action==='home')returnHome();
  else if(action==='open-wrong')returnHome('wrong');
  else if(action==='tab-chapters'||action==='tab-wrong'){tab=action==='tab-wrong'?'wrong':'chapters';wrongPage=0;render();}
  else if(action==='answer'){selected=el.dataset.answer;submit();}
  else if(action==='submit')submit();
  else if(action==='next'||action==='skip')next();
  else if(action==='prev'||action==='jump'){stopMedia();const s=state.session;if(!s)return;s.index=action==='prev'?Math.max(0,s.index-1):Number(el.dataset.index);selected=null;save();render();window.scrollTo(0,0);}
  else if(action==='peek'){const s=state.session;if(!s||s.results[s.ids[s.index]])return;s.results[s.ids[s.index]]={peek:true};save();render();if(state.prefs.video)playVideo();}
  else if(action==='finish')finish();
  else if(action==='play')playVideo();
  else if(action==='export')exportProgress();
  else if(action==='import')$('#import-file').click();
  else if(action==='recommend'){const weak=el.dataset.weak==='true';start(weak?chapterIds(id).filter(isPending):chapterIds(id).filter(x=>!state.records[x]?.attempts),chapterName(id)+(weak?' · 专项攻坚':' · 10题诊断'),'smart',weak?0:10);}
  else if(action==='random-review')start(allIds,'随机复习','random',30);
  else if(action==='wrong-practice')start(wrongIds(),'错题本 · 专项练习','smart');
  else if(action==='wrong-prev'||action==='wrong-next'){wrongPage+=action==='wrong-prev'?-1:1;render();}
  else if(action==='single')start([id],'自选单题','original');
  else if(action==='picked')start(state.picked,'我的自选题篮',state.prefs.order);
  else if(action==='search-practice'){const t=searchText.trim().toLowerCase();start(bank.questions.filter(q=>[q.question,q.analysis,q.txtExplain,...q.answers.map(a=>a.answer)].some(v=>plain(v).toLowerCase().includes(t))).map(q=>q.id),'检索结果练习',state.prefs.order);}
  else if(action==='retry-round')start(summaryData.wrong,'本轮错题复习','smart');
  else if(action==='chapters-all'||action==='chapters-none'){state.prefs.chapters=action==='chapters-all'?bank.chapters.map(c=>c.id):[];save();render();$('#plan-panel').open=true;}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.dataset.prefChapter){state.prefs.chapters=[...document.querySelectorAll('[data-pref-chapter]:checked')].map(e=>e.dataset.prefChapter);save();updatePlanCount();}
  else if(el.dataset.pref){const k=el.dataset.pref;state.prefs[k]=el.type==='checkbox'?el.checked:k==='limit'?Number(el.value):el.value;save();updatePlanCount();}
  else if(el.dataset.pick){const id=el.dataset.pick;if(el.checked&&!state.picked.includes(id))state.picked.push(id);else if(!el.checked)state.picked=state.picked.filter(x=>x!==id);save();if($('#picked-count'))$('#picked-count').textContent=state.picked.length;}
  else if(el.id==='wrong-chapter'||el.id==='wrong-filter'||el.id==='wrong-sort'){if(el.id==='wrong-chapter')wrongChapter=el.value;if(el.id==='wrong-filter')wrongFilter=el.value;if(el.id==='wrong-sort')wrongSort=el.value;wrongPage=0;render();}
});
document.addEventListener('input',event=>{if(event.target.id==='question-search'){searchText=event.target.value;renderSearch();}});
document.addEventListener('keydown',event=>{
  if(view!=='quiz'||event.altKey||event.ctrlKey||event.metaKey||event.repeat||['INPUT','SELECT','TEXTAREA','BUTTON','A','SUMMARY'].includes(event.target.tagName))return;
  const s=state.session,q=questions.get(s.ids[s.index]);
  if(!s.results[q.id]&&/^[1-4]$/.test(event.key)){const a=q.answers[Number(event.key)-1];if(a){selected=a.answerCode;submit();event.preventDefault();}}
  else if(event.key==='Enter'&&!s.results[q.id]){event.preventDefault();submit();}
});
$('#import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{
    if(file.size>2500000)throw new Error('备份文件过大');
    const imported=E.validate(JSON.parse(await file.text()));
    if(!confirm(`将用备份替换当前浏览器的进度（备份包含 ${Object.keys(imported.records).length} 道题的记录）。建议先导出当前进度。是否继续？`))return;
    stopMedia();state=imported;writeBlocked=false;storageError='';save();view='home';render();toast('进度已恢复。');
  }catch(error){toast('恢复失败：'+error.message);}finally{event.target.value='';}
});
window.addEventListener('storage',event=>{
  if(event.key!==E.key||document.querySelector('#study-profile')?.value)return;
  stopMedia();writeBlocked=true;storageError='另一标签页更新了进度。为避免相互覆盖，本页已暂停保存；请刷新后继续。';showStorageNotice();
});
render();
