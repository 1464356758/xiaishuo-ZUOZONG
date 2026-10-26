import {GitHubClient,decodeLocator,loadBook,readFormalChapter,suggestedChapter} from './hub-core.mjs';
import {safeFilename} from './core.mjs';
import {$,el,toast,localRead,localWrite,dateLabel,copyText,download,action} from './ui.mjs';
let current=null,connectTicket=0,chapterTicket=0;
const progressKey=book=>'novel-hub-copied-v1:'+book.client.repo.key+':'+(book.book.manifest.book.id||'empty');
function disable(){for(const id of ['partnerCopyAll','partnerCopyBody','partnerExport','partnerPrev','partnerNext'])$(id).disabled=true;}
function render(){if(!current)return;$('partnerTitle').textContent=current.book.manifest.book.title;$('partnerMeta').textContent=current.book.manifest.chapters.length+' 章正式正文 · 读取时间 '+dateLabel(current.loadedAt);$('partnerChapters').replaceChildren();for(const c of current.book.manifest.chapters){const b=el('button','chapter-choice'+(current.chapter?.number===c.number?' active':''),'第'+c.number+'章 '+c.title);action(b,()=>openChapter(c));$('partnerChapters').append(b);}const p=localRead(progressKey(current),null);$('copyProgress').textContent=p?'本机上次复制：第'+p.chapter+'章 · '+dateLabel(p.at)+'。复制不代表平台已发布。':'本机尚未记录复制进度。请先与作者确认本次要发布的章号。';}
async function connect(){
  const ticket=++connectTicket;chapterTicket++;current=null;disable();$('partnerBook').hidden=true;$('partnerError').hidden=true;$('connectCode').disabled=true;
  try{const locator=await decodeLocator($('partnerCode').value),client=new GitHubClient(locator.repository_url),book=await loadBook(client,locator.branch);if(ticket!==connectTicket)return;if(locator.book_id&&book.manifest.book.id!==locator.book_id)throw new Error('作品身份已改变，请向作者索取当前代发码。');current={client,book,locator,chapter:null,text:null,loadedAt:new Date().toISOString()};$('partnerBook').hidden=false;render();if(!book.manifest.chapters.length){$('partnerChapterTitle').textContent='暂无正式章节';$('partnerChapterStatus').textContent='等待作者完成检查并采用正文。';$('partnerText').textContent='';return;}const progress=localRead(progressKey(current),null);await openChapter(suggestedChapter(book.manifest.chapters,progress));}
  catch(e){if(ticket===connectTicket){$('partnerError').textContent=e.message;$('partnerError').hidden=false;}}
  finally{if(ticket===connectTicket)$('connectCode').disabled=false;}
}
async function openChapter(chapter){
  const book=current;if(!book)return;const ticket=++chapterTicket;book.chapter=chapter;book.text=null;disable();$('partnerText').textContent='';$('partnerChapterTitle').textContent='第'+chapter.number+'章 '+chapter.title;$('partnerChapterStatus').textContent='正在核对正式正文…';render();
  try{const text=await readFormalChapter(book.client,book.book,chapter);if(current!==book||ticket!==chapterTicket)return;book.text=text;$('partnerText').textContent=text;$('partnerChapterStatus').textContent='正文 SHA-256 已核对 · '+chapter.han_count+' 汉字';for(const id of ['partnerCopyAll','partnerCopyBody','partnerExport'])$(id).disabled=false;$('partnerPrev').disabled=chapter.number===1;$('partnerNext').disabled=chapter.number===book.book.manifest.chapters.length;}
  catch(e){if(ticket===chapterTicket)$('partnerChapterStatus').textContent=e.message;}
}
async function copyChapter(withTitle){const book=current;if(!book||book.text===null)throw new Error('正文尚未核验。');await copyText(withTitle?'第'+book.chapter.number+'章 '+book.chapter.title+'\n\n'+book.text:book.text);try{localWrite(progressKey(book),{chapter:book.chapter.number,sha256:book.chapter.sha256,at:new Date().toISOString()});render();toast('第'+book.chapter.number+'章已复制，请到平台实际发布。');}catch(e){toast('正文已复制，但本机进度保存失败。'+e.message);}}
$('codeForm').addEventListener('submit',event=>{event.preventDefault();connect();});action($('partnerRefresh'),connect);action($('partnerCopyAll'),()=>copyChapter(true));action($('partnerCopyBody'),()=>copyChapter(false));action($('partnerExport'),()=>{if(!current||current.text===null)throw new Error('正文尚未核验。');download('第'+current.chapter.number+'章 '+current.chapter.title+'\n\n'+current.text,safeFilename(current.book.manifest.book.title+'_第'+current.chapter.number+'章'));});
for(const [id,step] of [['partnerPrev',-1],['partnerNext',1]])action($(id),()=>{const c=current?.book.manifest.chapters[(current.chapter?.number||0)-1+step];if(c)return openChapter(c);});
disable();if(location.hash.startsWith('#NX1.')){$('partnerCode').value=location.hash.slice(1);connect();}
