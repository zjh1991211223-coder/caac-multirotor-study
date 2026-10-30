/* Local progress is intentionally independent from the source platform. */
const StudyEngine = (() => {
  const bank = JSON.parse(document.getElementById('bank-data').textContent);
  const activeIds = bank.questions.map(q => q.id), activeIdSet = new Set(activeIds);
  const archivedQuestions = Array.isArray(bank.archivedQuestions) ? bank.archivedQuestions : [];
  const originalOrder = new Map((bank.originalQuestionIds || []).map((id, i) => [id, i]));
  let nextOrder = originalOrder.size;
  const questions = new Map([...bank.questions, ...archivedQuestions].map((q, i) => [q.id, {
    ...q, order: originalOrder.size ? originalOrder.get(q.id) ?? nextOrder++ : i,
    archived: !activeIdSet.has(q.id)
  }]));
  const key = 'caac-study-progress-v1:' + bank.id;
  const defaults = () => ({ chapters: bank.chapters.map(c => c.id), scope: 'all', order: 'smart', limit: 30, tips: true, explanation: true, video: true, autoNext: true });
  const fresh = () => ({ version: 1, bankId: bank.id, records: {}, session: null, prefs: defaults(), picked: [] });
  const today = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  function stats(ids, state) {
    const records = ids.map(id => state.records[id]).filter(Boolean);
    const attempted = records.filter(r => r.attempts > 0).length;
    const submissions = records.reduce((n, r) => n + r.attempts, 0);
    const correct = records.reduce((n, r) => n + r.correct, 0);
    const wrong = records.filter(r => r.wrong > 0 && r.streak < 2).length;
    const mastered = records.filter(r => r.wrong > 0 && r.streak >= 2).length;
    return { attempted, submissions, correct, wrong, mastered, accuracy: submissions ? correct / submissions * 100 : null, total: ids.length };
  }
  function register(state, id, answer, options = {}) {
    const q = questions.get(id);
    if (!q || !q.answers.some(a => a.answerCode === answer)) throw new Error('无效题目或选项');
    const right = q.answers.some(a => a.answerCode === answer && a.isRight);
    const previous = state.records[id];
    const r = previous || { attempts: 0, correct: 0, wrong: 0, streak: 0, daily: {} };
    const at = Number.isFinite(options.at) ? options.at : Date.now();
    const date = typeof options.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(options.day) ? options.day : today();
    const record = {
      ...r, attempts: r.attempts + 1, correct: r.correct + Number(right),
      wrong: r.wrong + Number(!right), streak: right ? r.streak + 1 : 0,
      lastAnswer: answer, lastCorrect: right, lastAt: at,
      daily: { ...r.daily, [date]: (r.daily[date] || 0) + 1 }
    };
    if (Number.isFinite(options.elapsedMs) && options.elapsedMs >= 0) {
      record.timing = { count: (r.timing?.count || 0) + 1, totalMs: (r.timing?.totalMs || 0) + options.elapsedMs, lastMs: options.elapsedMs };
    }
    state.records[id] = record;
    return { right, answer, correctAnswers: q.answers.filter(a => a.isRight).map(a => a.answerCode) };
  }
  function order(ids, mode, state) {
    const list = [...ids];
    if (mode === 'random') {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }
    if (mode === 'original') return list.sort((a, b) => questions.get(a).order - questions.get(b).order);
    const tier = id => {
      const r = state.records[id];
      if (r?.wrong > 0 && r.streak < 2) return 0;
      if (!r?.attempts) return 1;
      return 2;
    };
    return list.sort((a, b) => {
      const ra = state.records[a], rb = state.records[b];
      return tier(a) - tier(b) ||
        (tier(a) === 0 ? (rb?.wrong || 0) - (ra?.wrong || 0) || (ra?.streak || 0) - (rb?.streak || 0) || (ra?.lastAt || 0) - (rb?.lastAt || 0) : 0) ||
        questions.get(a).order - questions.get(b).order;
    });
  }
  function examPlan() {
    const plan = bank.chapters.map((chapter, index) => ({
      chapterId: chapter.id, index,
      bankCount: bank.questions.filter(q => q.chapterId === chapter.id).length
    }));
    const total = plan.reduce((n, chapter) => n + chapter.bankCount, 0);
    if (total !== bank.questions.length || total < 100) throw new Error('题库章节归属或题量不满足100题组卷要求');
    for (const chapter of plan) {
      chapter.questionCount = Math.floor(chapter.bankCount * 100 / total);
      chapter.remainder = chapter.bankCount * 100 % total;
    }
    const extra = 100 - plan.reduce((n, chapter) => n + chapter.questionCount, 0);
    const ranked = [...plan].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let i = 0; i < extra; i++) ranked[i].questionCount++;
    return plan.map(({ chapterId, bankCount, questionCount }) => ({ chapterId, bankCount, questionCount }));
  }
  function sampleExam() {
    const plan = examPlan();
    const updated = new Set((bank.updateBatch?.questionIds || []).filter(id => activeIdSet.has(id)));
    const minimumUpdated = Math.min(3, updated.size);
    const reserved = new Map(plan.map(chapter => [chapter.chapterId, []]));
    const quotas = new Map(plan.map(chapter => [chapter.chapterId, chapter.questionCount]));
    let reservedCount = 0;
    // Reserve new questions inside the real chapter quotas; the update collection is not an extra sampling chapter.
    for (const id of order([...updated], 'random')) {
      if (reservedCount >= minimumUpdated) break;
      const chapterId = questions.get(id).chapterId, selected = reserved.get(chapterId);
      if (selected && selected.length < quotas.get(chapterId)) { selected.push(id); reservedCount++; }
    }
    if (reservedCount < minimumUpdated) throw new Error('当前章节配额无法容纳更新题，请检查题库归属');
    const selected = plan.flatMap(chapter => {
      const first = reserved.get(chapter.chapterId);
      const pool = bank.questions.filter(q => q.chapterId === chapter.chapterId && !first.includes(q.id)).map(q => q.id);
      return [...first, ...order(pool, 'random').slice(0, chapter.questionCount - first.length)];
    });
    const ids = order(selected, 'random');
    if (ids.length !== 100 || new Set(ids).size !== 100) throw new Error('模拟试卷必须恰好包含100道不同题目');
    return { ids, sampling: {
      version: 'chapter-proportional-v1', reference: 'current-question-bank',
      catalogRevision: bank.catalogRevision || 'legacy-1173', chapters: plan,
      minimumUpdated, selectedUpdated: ids.filter(id => updated.has(id)).length
    } };
  }
  function validate(raw, { allowSession = false } = {}) {
    if (!raw || raw.version !== 1 || raw.bankId !== bank.id || !raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)) throw new Error('备份版本或题库不匹配');
    const state = fresh();
    const integer = v => Number.isSafeInteger(v) && v >= 0 && v <= 10000000;
    for (const [id, r] of Object.entries(raw.records)) {
      if (!questions.has(id) || !r || !integer(r.attempts) || !integer(r.correct) || !integer(r.wrong) || !integer(r.streak) || r.attempts < 1 || r.correct + r.wrong !== r.attempts || r.streak > r.correct || typeof r.lastCorrect !== 'boolean' || !Number.isFinite(r.lastAt) || r.lastAt < 0 || r.lastAt > Date.now() + 86400000) throw new Error('备份包含无效答题记录');
      const q = questions.get(id);
      if (!q.answers.some(a => a.answerCode === r.lastAnswer) || q.answers.some(a => a.answerCode === r.lastAnswer && a.isRight) !== r.lastCorrect || (!r.lastCorrect && r.streak !== 0) || (r.lastCorrect && r.streak === 0)) throw new Error('备份的答案记录不一致');
      const daily = {};
      if (!r.daily || typeof r.daily !== 'object' || Array.isArray(r.daily)) throw new Error('备份缺少每日记录');
      for (const [day, n] of Object.entries(r.daily)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !integer(n)) throw new Error('每日记录格式无效');
        daily[day] = n;
      }
      if (Object.values(daily).reduce((a, b) => a + b, 0) !== r.attempts) throw new Error('每日记录与总次数不一致');
      state.records[id] = { attempts: r.attempts, correct: r.correct, wrong: r.wrong, streak: r.streak, daily, lastAnswer: r.lastAnswer, lastCorrect: r.lastCorrect, lastAt: r.lastAt };
      if(r.timing && integer(r.timing.count) && r.timing.count>0 && r.timing.count<=r.attempts && Number.isFinite(r.timing.totalMs) && r.timing.totalMs>=0 && Number.isFinite(r.timing.lastMs) && r.timing.lastMs>=0) state.records[id].timing={count:r.timing.count,totalMs:r.timing.totalMs,lastMs:r.timing.lastMs};
    }
    if (raw.prefs && typeof raw.prefs === 'object') {
      const p = raw.prefs;
      if (Array.isArray(p.chapters)) state.prefs.chapters = [...new Set(p.chapters)].filter(id => bank.chapters.some(c => c.id === id));
      if (['all', 'unseen', 'wrong'].includes(p.scope)) state.prefs.scope = p.scope;
      if (['smart', 'original', 'random'].includes(p.order)) state.prefs.order = p.order;
      if ([10, 20, 30, 0].includes(p.limit)) state.prefs.limit = p.limit;
      for (const k of ['tips', 'explanation', 'video', 'autoNext']) if (typeof p[k] === 'boolean') state.prefs[k] = p[k];
    }
    if (Array.isArray(raw.picked)) state.picked = [...new Set(raw.picked)].filter(id => questions.has(id));
    if (allowSession && raw.session) {
      const s = raw.session;
      if (Array.isArray(s.ids) && s.ids.length && s.ids.length <= questions.size && new Set(s.ids).size === s.ids.length && s.ids.every(id => questions.has(id)) && Number.isInteger(s.index) && s.index >= 0 && s.index < s.ids.length && typeof s.title === 'string' && s.title.length < 120) {
        const results = {};
        for (const [id, r] of Object.entries(s.results || {})) {
          if (s.ids.includes(id) && r && (r.peek === true || questions.get(id).answers.some(a => a.answerCode === r.answer))) results[id] = r.peek ? { peek: true } : { answer: r.answer, right: questions.get(id).answers.some(a => a.answerCode === r.answer && a.isRight) };
        }
        state.session = { ids: s.ids, index: s.index, title: s.title, mode: typeof s.mode === 'string' ? s.mode : 'original', results };
        if(typeof s.uid==='string')state.session.uid=s.uid;
        if(s.timeSpent && typeof s.timeSpent==='object')state.session.timeSpent=Object.fromEntries(Object.entries(s.timeSpent).filter(([id,ms])=>s.ids.includes(id)&&Number.isFinite(ms)&&ms>=0));
      }
    }
    if(raw.exams && typeof raw.exams==='object') {
      const validExam=x=>x&&typeof x.id==='string'&&Array.isArray(x.ids)&&x.ids.length===100&&new Set(x.ids).size===100&&x.ids.every(id=>questions.has(id))&&Number.isFinite(x.startedAt)&&Number.isFinite(x.deadline)&&Number.isInteger(x.index)&&x.index>=0&&x.index<100&&x.answers&&typeof x.answers==='object'&&Object.entries(x.answers).every(([id,code])=>x.ids.includes(id)&&questions.get(id).answers.some(a=>a.answerCode===code))&&x.optionOrder&&x.ids.every(id=>{const codes=questions.get(id).answers.map(a=>a.answerCode),given=x.optionOrder[id];return Array.isArray(given)&&given.length===codes.length&&new Set(given).size===codes.length&&given.every(c=>codes.includes(c));});
      state.exams={active:validExam(raw.exams.active)?raw.exams.active:null,history:Array.isArray(raw.exams.history)?raw.exams.history.filter(x=>validExam(x)&&Number.isFinite(x.finishedAt)&&Number.isInteger(x.correct)&&x.correct>=0&&x.correct<=100):[]};
    }
    return state;
  }
  return { bank, questions, activeIds, key, fresh, today, stats, register, order, examPlan, sampleExam, validate };
})();
