from pathlib import Path
import argparse
import json,re
BASE=Path(__file__).resolve().parent
original=(BASE/'previous-release.html').read_text(encoding='utf-8-sig')
engine=(BASE/'engine.js').read_text(encoding='utf-8-sig')
app=(BASE/'app.js').read_text(encoding='utf-8-sig')
# Keep the released course layer, embedded bank and styling intact.
script=re.search(r'<script>(.*?)</script>',original,re.S)[1]
start=script.index('let courseData =')
end=script.index('const E = StudyEngine')
course=script[start:end]
old="错题本 <span>${m.wrong}</span></button></div>"
new="错题本 <span>${m.wrong}</span></button><button role=\"tab\" aria-selected=\"${tab==='course'}\" class=\"tab ${tab==='course'?'active':''}\" data-course-tab>课程口诀与方法</button></div>"
assert old in app;app=app.replace(old,new).replace(':wrongMarkup()}',":tab==='course'?courseMarkup():wrongMarkup()}")
needle="${state.prefs.video?videoMarkup(q):''}"
app=app.replace(needle,needle+'${courseQuestionMarkup(q.id)}')
# Course deep links must run after the study layer is declared.
deep="function openCourseHash(){const m=location.hash.match(/^#course-episode-(\\d+)$/);if(m&&courseData.episodes.some(e=>e.number===Number(m[1])))selectCourseEpisode(Number(m[1]));}window.addEventListener('hashchange',openCourseHash);openCourseHash();"
config=(BASE/'cloud-config.json').read_text(encoding='utf8')
features=(BASE/'features.js').read_text(encoding='utf8')
features+='\n'+(BASE/'text-backup.js').read_text(encoding='utf8')
html=re.sub(r'<script>.*?</script>',lambda m:'<script>'+engine+'\n'+course+'\n'+app+'\n'+features+'\n'+deep+'</script>',original,count=1,flags=re.S)
html=html.replace('</style>',(BASE/'features.css').read_text(encoding='utf8')+'</style>',1)
html=html.replace('<script>','<script id="cloud-config" type="application/json">'+config+'</script><script>',1)
html=html.replace('CAAC 超视距多旋翼 · 课程技巧与视频已更新','CAAC 超视距多旋翼 · 用时专项／模拟考试／云端进度')
html=html.replace('学习进度保存在当前浏览器，各人独立；可通过备份、恢复迁移到其他浏览器或设备。课程资料为学习整理，疑点和使用条件请结合详细笔记核对。','选择姓名后自动同步云端，未选择时只存本机。三位用户按姓名分开，无密码保护。课程方法的条件和疑点请结合笔记核对。')
parser=argparse.ArgumentParser();parser.add_argument('--output',default=str(BASE/'index.html'));args=parser.parse_args()
Path(args.output).write_text(html,encoding='utf8')
bank=json.loads(re.search(r'<script id="bank-data"[^>]*>(.*?)</script>',html,re.S)[1]);assert len(bank['questions'])==1173
assert json.loads(re.search(r'<script id="bank-data"[^>]*>(.*?)</script>',original,re.S)[1])==bank
print('Built v2; original bank and all IDs unchanged; bytes',len(html.encode()))
