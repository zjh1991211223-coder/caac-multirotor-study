from pathlib import Path
import argparse
import json
import re
from collections import Counter

BASE = Path(__file__).resolve().parent
BANK_PATTERN = r'(<script id="bank-data"[^>]*>)(.*?)(</script>)'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_bank(bank, baseline, updated):
    require(isinstance(bank, dict), '题库必须是 JSON 对象')
    require(bank.get('id') == baseline['id'], '题库 ID 必须保留旧版值，避免丢失进度和备份兼容性')
    rows, chapters = bank.get('questions'), bank.get('chapters')
    require(isinstance(rows, list) and rows, '题库缺少 questions 列表')
    require(all(isinstance(q, dict) and isinstance(q.get('id'), str) and q['id'] for q in rows), '题目 ID 必须是非空字符串')
    ids = [q['id'] for q in rows]
    require(len(ids) == len(set(ids)), '题库存在重复题目 ID')
    old_ids = {q['id'] for q in baseline['questions']}
    require(len(old_ids) == len(baseline['questions']) == 1173, '旧版基线必须包含 1173 个唯一题目 ID')
    archived = bank.get('archivedQuestions', [])
    require(isinstance(archived, list) and all(isinstance(q, dict) and isinstance(q.get('id'), str) for q in archived), '归档旧题格式无效')
    archived_ids = {q['id'] for q in archived}
    require(len(archived_ids) == len(archived) and not (archived_ids & set(ids)), '归档旧题与当前题目不得重复')
    require(archived_ids == old_ids - set(ids), '下架旧题必须完整保留于归档快照')
    old_questions = {q['id']: q for q in baseline['questions']}
    require(all(q == old_questions.get(q['id']) for q in archived), '归档题必须保留原题干、选项及原答案，避免改变历史试卷')
    require(isinstance(chapters, list) and chapters, '题库缺少真实章节列表')
    require(all(isinstance(c, dict) and isinstance(c.get('id'), str) and c['id'] for c in chapters), '章节 ID 必须是非空字符串')
    chapter_ids = [c['id'] for c in chapters]
    require(len(chapter_ids) == len(set(chapter_ids)), '真实章节 ID 不得重复')
    require('updates' not in chapter_ids, '更新题目是虚拟入口，不得加入真实章节列表')
    require(all(q.get('chapterId') in chapter_ids for q in rows), '每道题必须归属一个有效的真实章节')
    counts = Counter(q['chapterId'] for q in rows)
    require(all(type(c.get('count')) is int and c['count'] == counts[c['id']] for c in chapters), '章节 count 与实际唯一题目数不一致')
    for q in rows + archived:
        answers = q.get('answers')
        require(isinstance(answers, list) and len(answers) >= 2, '题目选项不完整：' + q['id'])
        require(all(isinstance(a, dict) and isinstance(a.get('answerCode'), str) and a['answerCode'] and type(a.get('isRight')) is bool for a in answers), '题目选项或正确答案格式无效：' + q['id'])
        codes = [a['answerCode'] for a in answers]
        require(len(codes) == len(set(codes)) and sum(a['isRight'] for a in answers) == 1, '单选题必须有唯一选项代码和一个正确答案：' + q['id'])
    added_ids = set(ids) - old_ids
    if updated:
        require(bank.get('originalQuestionIds') == [q['id'] for q in baseline['questions']], '必须保留旧1173题的原始序号映射')
        require(len(rows) == 1213 and len(added_ids) - len(archived_ids) == 40, '本次更新应为 1213 道当前题，净增 40 道')
        require((len(added_ids), len(archived_ids)) in ((43, 3), (40, 0)), '题库新增／下架数量与已审核范围不符')
        require(isinstance(bank.get('catalogRevision'), str) and bank['catalogRevision'].strip(), '新版必须提供 catalogRevision 字符串')
        batch = bank.get('updateBatch')
        require(isinstance(batch, dict), '新版缺少 updateBatch 元数据')
        require(all(isinstance(batch.get(k), str) and batch[k].strip() for k in ('id', 'title')), 'updateBatch 必须提供非空 id 和 title')
        batch_ids = batch.get('questionIds')
        require(isinstance(batch_ids, list) and all(isinstance(qid, str) for qid in batch_ids), 'updateBatch.questionIds 必须是题目 ID 列表')
        require(len(batch_ids) == len(set(batch_ids)) == len(added_ids) and set(batch_ids) == added_ids, '更新集合必须准确引用相对 1173 题基线实际新增的唯一 ID')
        require(set(batch.get('retiredQuestionIds', [])) == archived_ids, '更新元数据必须准确列出归档旧题 ID')
    else:
        require(not added_ids and len(rows) == 1173, '未提供更新文件时只能构建原 1173 题基线')
    changes = []
    for q in rows:
        previous = old_questions.get(q['id'])
        if previous is None:
            continue
        fields = sorted(k for k in set(previous) | set(q) if previous.get(k) != q.get(k))
        if not fields:
            continue
        change = {'id': q['id'], 'fields': fields}
        if 'question' in fields:
            change.update(previousQuestion=previous.get('question'), updatedQuestion=q.get('question'))
        if 'answers' in fields:
            change.update(previousAnswers=previous.get('answers'), updatedAnswers=q.get('answers'))
        changes.append(change)
    return changes


def main():
    parser = argparse.ArgumentParser(description='构建 CAAC 学习站；优先使用已核对的 bank-data.json')
    parser.add_argument('--output', type=Path, default=BASE / 'index.html')
    parser.add_argument('--bank-file', type=Path, help='显式指定新版题库；省略时读取 source-v2/bank-data.json（若存在）')
    parser.add_argument('--allow-existing-question-changes', action='store_true', help='人工核对打印的旧题差异后，允许本次构建采用这些差异')
    args = parser.parse_args()
    try:
        original = (BASE / 'previous-release.html').read_text(encoding='utf-8-sig')
        baseline_match = re.search(BANK_PATTERN, original, re.S)
        require(baseline_match is not None, 'previous-release.html 缺少 bank-data')
        baseline = json.loads(baseline_match[2])
        default_bank = BASE / 'bank-data.json'
        bank_path = args.bank_file or (default_bank if default_bank.is_file() else None)
        bank = json.loads(bank_path.read_text(encoding='utf-8-sig')) if bank_path else baseline
        changes = validate_bank(bank, baseline, updated=bank_path is not None)
        if changes:
            print(json.dumps({'existingQuestionChanges': len(changes), 'changes': changes}, ensure_ascii=False))
            require(args.allow_existing_question_changes, '发现旧题内容或答案差异，尚未写出页面。请先审核上方差异；确认采用后加 --allow-existing-question-changes 重建')
        bank_json = json.dumps(bank, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
        html = re.sub(BANK_PATTERN, lambda m: m[1] + bank_json + m[3], original, count=1, flags=re.S)
        engine = (BASE / 'engine.js').read_text(encoding='utf-8-sig')
        app = (BASE / 'app.js').read_text(encoding='utf-8-sig')
        # Keep the released course layer and styling; swap only the validated bank.
        script = re.search(r'<script>(.*?)</script>', original, re.S)[1]
        start = script.index('let courseData =')
        end = script.index('const E = StudyEngine')
        course = script[start:end]
        old = '错题本 <span>${m.wrong}</span></button></div>'
        new = '错题本 <span>${m.wrong}</span></button><button role="tab" aria-selected="${tab===\'course\'}" class="tab ${tab===\'course\'?\'active\':\'\'}" data-course-tab>课程口诀与方法</button></div>'
        require(old in app, 'app.js 缺少预期的课程标签接入点')
        app = app.replace(old, new).replace(':wrongMarkup()}', ":tab==='course'?courseMarkup():wrongMarkup()}")
        needle = "${state.prefs.video?videoMarkup(q):''}"
        require(needle in app, 'app.js 缺少预期的课程解析接入点')
        app = app.replace(needle, needle + '${courseQuestionMarkup(q.id)}')
        # Course deep links must run after the study layer is declared.
        deep = "function openCourseHash(){const m=location.hash.match(/^#course-episode-(\\d+)$/);if(m&&courseData.episodes.some(e=>e.number===Number(m[1])))selectCourseEpisode(Number(m[1]));}window.addEventListener('hashchange',openCourseHash);openCourseHash();"
        config = (BASE / 'cloud-config.json').read_text(encoding='utf8')
        features = (BASE / 'features.js').read_text(encoding='utf8') + '\n' + (BASE / 'text-backup.js').read_text(encoding='utf8')
        html = re.sub(r'<script>.*?</script>', lambda m: '<script>' + engine + '\n' + course + '\n' + app + '\n' + features + '\n' + deep + '</script>', html, count=1, flags=re.S)
        html = html.replace('</style>', (BASE / 'features.css').read_text(encoding='utf8') + (BASE / 'mobile.css').read_text(encoding='utf8') + '</style>', 1)
        html = html.replace('<script>', '<script id="cloud-config" type="application/json">' + config + '</script><script>', 1)
        html = html.replace('CAAC 超视距多旋翼 · 课程技巧与视频已更新', 'CAAC 超视距多旋翼 · 用时专项／模拟考试／云端进度')
        html = html.replace('学习进度保存在当前浏览器，各人独立；可通过备份、恢复迁移到其他浏览器或设备。课程资料为学习整理，疑点和使用条件请结合详细笔记核对。', '选择姓名后自动同步云端，未选择时只存本机。三位用户按姓名分开，无密码保护。课程方法的条件和疑点请结合笔记核对。')
        rendered_bank = json.loads(re.search(BANK_PATTERN, html, re.S)[2])
        require(rendered_bank == bank, '生成页面中的题库与已验证数据不一致')
        args.output.write_text(html, encoding='utf8')
        print(json.dumps({'built': str(args.output), 'questionCount': len(bank['questions']), 'newQuestionCount': len(bank.get('updateBatch', {}).get('questionIds', [])), 'archivedQuestionCount': len(bank.get('archivedQuestions', [])), 'updatedBankReady': bank_path is not None, 'existingQuestionChangesReviewed': len(changes), 'bytes': len(html.encode())}, ensure_ascii=False))
        if bank_path is None:
            print('未找到 bank-data.json：本次仅构建原 1173 题；新版 1213 题尚未接入。')
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
