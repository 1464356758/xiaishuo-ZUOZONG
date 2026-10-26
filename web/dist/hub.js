import {GitHubClient,HubError,parseRepository,safeBranch,blankRegistry,validateRegistry,registryFingerprint,validateChatURL,dayInShanghai,tomorrow,loadRegistry,saveRegistry,validateReport,reportState,inspectRegistry,loadBook,readFormalChapter,encodeLocator,STATUS,writingPrompt,repairPrompt,checkerPrompt,randomId,validateReaderURL,validateLocalBackup} from './hub-core.mjs';
import {safeFilename,RequestGate} from './core.mjs';
import {$,el,toast,localRead,localWrite,dateLabel,copyText,download,action,confirmAction} from './ui.mjs';

const CONFIG='novel-hub-config-v1',PRIVATE='novel-hub-private-v1';
let config=localRead(CONFIG,{});try{config=config.repository_url?{repository_url:parseRepository(config.repository_url).url,branch:safeBranch(config.branch||'')}:{};}catch{config={};}
let prefs=localRead(PRIVATE,{chats:{},ledger:[],reader_url:''});if(!prefs||typeof prefs!=='object')prefs={};prefs.chats??={};if(!Array.isArray(prefs.ledger))prefs.ledger=[];
const state={registry:blankRegistry(),baseFileHash:null,remoteLoaded:false,dirty:false,report:null,live:null,saving:false,checking:false,filter:'all',editing:null,client:null};
const spaceKey=()=> 'novel-hub-draft-v1:'+(config.repository_url?parseRepository(config.repository_url).key:'unbound')+':'+(config.branch||'default');
function restoreDraft(){const value=localRead(spaceKey(),null);if(value){try{state.registry=validateRegistry(value.registry);state.baseFileHash=value.baseFileHash||null;state.dirty=value.dirty===true;state.lastSaved=value.lastSaved||null;state.pendingBase=value.pendingBase===true;}catch{toast('本机清单格式异常，未采用；请重新读取远端。');}}}
restoreDraft();
function persist(){localWrite(spaceKey(),{registry:state.registry,baseFileHash:state.baseFileHash,dirty:state.dirty,lastSaved:state.lastSaved||null,pendingBase:state.pendingBase===true});}
function persistPrivate(){localWrite(PRIVATE,{chats:prefs.chats,ledger:prefs.ledger,reader_url:prefs.reader_url||''});}
function notice(message,error=false){$('globalNotice').hidden=!message;$('globalNotice').textContent=message;$('globalNotice').className='notice'+(error?' error':'');}
function changed(){state.dirty=true;try{persist();}catch(e){notice(e.message,true);}render();}
function ensureMutable(){if(state.saving)throw new HubError('正在保存，请等核对完成后再修改。');}
function showText(title,text){$('textTitle').textContent=title;$('textContent').value=text;$('textDialog').showModal();}
const labels={dashboard:['今日工作台','把故事写下去。','正文留在仓库，在这里掌握每一部作品的更新。'],reports:['检查报告','每一次更新，都有依据。','区分夜间日报与实时核验，处理真正需要你介入的异常。'],delivery:['代发工具','把下一章，交给合作人。','生成稳定代发码，让对方专注阅读、核对和发布。'],ledger:['投入与收益','让投入有记录。','使用实际数据，判断每一部作品值得投入多少时间。'],settings:['连接与设置','连接你的创作工作区。','公开数据直接读取，写入凭证仅在本次页面会话中使用。']};
function setView(name){if(!labels[name])return;for(const key of Object.keys(labels))$(key+'View').hidden=key!==name;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$('viewLabel').textContent=labels[name][0];$('pageTitle').textContent=labels[name][1];$('pageSubtitle').textContent=labels[name][2];if(name==='delivery')renderBookOptions();if(name==='ledger')renderLedger();}
document.querySelectorAll('[data-view]').forEach(b=>action(b,()=>setView(b.dataset.view)));
document.querySelectorAll('[data-close]').forEach(b=>action(b,()=>$(b.dataset.close).close()));
action($('setupButton'),()=>setView('settings'));
const badge=(status,label)=>el('span','badge '+status,label||STATUS[status]||'待核验');
let renderSeq=0;
async function render(){
  const seq=++renderSeq,registry=state.registry,fp=await registryFingerprint(registry);if(seq!==renderSeq)return;
  const info=await reportState(state.report,registry);if(seq!==renderSeq)return;
  const liveGood=state.live?.date===dayInShanghai()&&state.live.registry_fingerprint===fp;
  const current=liveGood?state.live:info.fresh?state.report:null,results=new Map((current?.results||[]).map(r=>[r.id,r]));
  const count=registry.books.filter(b=>b.enabled).length;$('selectedCount').replaceChildren(document.createTextNode(count),el('small',null,'部'));
  $('selectedCount').parentElement.querySelector('p').textContent=state.dirty?'本地已勾选 · 尚未同步':'按远端保存清单执行';
  $('updatedCount').textContent=current?current.results.filter(r=>r.status==='updated').length:'—';
  $('attentionCount').textContent=current?current.results.filter(r=>['missing','pending','unknown','setup'].includes(r.status)).length:'—';
  $('updatedHint').textContent=liveGood?'实时核验 · 当前本地清单':info.fresh?'依据今日远端日报':'等待检查结果';
  $('latestCheck').textContent=current?dateLabel(current.checked_at,true):'—';$('reportFreshness').textContent=liveGood?'本机实时核验结果':info.label;
  $('welcomeCard').hidden=!!config.repository_url;
  $('connectionLabel').replaceChildren(el('i'),document.createTextNode(config.repository_url?parseRepository(config.repository_url).name:'尚未连接管理仓库'));$('connectionLabel').classList.toggle('connected',state.remoteLoaded);
  $('saveIndicator').textContent=state.saving?'● 正在写入并核对':state.dirty?'● 有未保存修改':state.lastSaved?'● 已保存 '+dateLabel(state.lastSaved):'● 本地清单';$('saveIndicator').classList.toggle('dirty',state.dirty);
  $('saveHint').textContent=state.dirty?'勾选尚未同步，保存后总检查任务才能读取。':'勾选控制检查范围；定时写作需在 GPT 中另行设置。';
  $('saveBooks').disabled=state.saving;$('saveBooks').textContent=state.saving?'正在保存与核对…':'保存到 GitHub ↗';
  const q=$('bookSearch').value.trim().toLowerCase();$('bookRows').replaceChildren();
  let visible=0;
  for(const book of registry.books){
    const result=!book.enabled?{status:'paused',reason:'当前清单未勾选。'}:results.get(book.id);
    if(q&&!book.title.toLowerCase().includes(q))continue;
    if(state.filter==='enabled'&&!book.enabled)continue;
    if(state.filter==='attention'&&!['missing','pending','unknown','setup'].includes(result?.status))continue;
    visible++;const row=el('tr'),checkTd=el('td'),check=el('input');check.type='checkbox';check.checked=book.enabled;check.disabled=state.saving;check.setAttribute('aria-label','检查《'+book.title+'》');check.addEventListener('change',()=>{try{ensureMutable();book.enabled=check.checked;changed();}catch(e){toast(e.message);check.checked=book.enabled;}});checkTd.append(check);row.append(checkTd);
    const titleTd=el('td'),cell=el('div','book-cell'),avatar=el('span','book-avatar',book.title.slice(0,1)),words=el('div');words.append(el('span','book-title',book.title),el('span','book-meta',Number.isInteger(result?.chapters)?'正式采用 '+result.chapters+' 章':book.baseline?'接入时 '+book.baseline.chapter_count+' 章':'待核验章节'));cell.append(avatar,words);titleTd.append(cell);row.append(titleTd);
    const time=el('td');time.append(el('div',null,book.expected_time),el('span','book-meta','北京时间 · 宽限 '+book.grace_minutes+' 分钟'));row.append(time);
    const statusTd=el('td');statusTd.append(badge(result?.status||'unknown',result?undefined:'待核验'));const note=el('span','status-note',result?.reason||'尚无匹配当前清单的本日结果。');note.title=note.textContent;statusTd.append(note);row.append(statusTd);
    const actionsTd=el('td'),actions=el('div','row-actions');
    const read=el('button',null,'阅读'),edit=el('button',null,'编辑'),gpt=el('button',null,'GPT ↗');edit.disabled=state.saving;action(read,()=>openReader(book));action(edit,()=>openBookDialog(book));action(gpt,()=>openChat(book));actions.append(read,edit,gpt);
    const menu=el('select');menu.setAttribute('aria-label','《'+book.title+'》更多操作');for(const [value,label] of [['','更多'],['schedule','定时指令'],['repair','补更指令'],['code','代发码'],['pause','停更步骤'],['remove','移出清单']]){const o=el('option',null,label);o.value=value;menu.append(o);}menu.addEventListener('change',()=>{const v=menu.value;menu.value='';Promise.resolve().then(()=>bookAction(book,v)).catch(e=>toast(e.message));});actions.append(menu);actionsTd.append(actions);row.append(actionsTd);$('bookRows').append(row);
  }
  $('booksEmpty').hidden=visible>0;
  if(registry.books.length&&!visible){$('booksEmpty').querySelector('h3').textContent='当前筛选下没有小说。';$('booksEmpty').querySelector('p').textContent='可以切换筛选或搜索其他书名。';}else{$('booksEmpty').querySelector('h3').textContent='你的下一部故事，从这里开始。';$('booksEmpty').querySelector('p').textContent='添加公开小说仓库，即可阅读正文、生成代发码并管理更新。';}
  renderBookOptions();renderReports(info);
}
function renderBookOptions(){for(const id of ['deliveryBook','ledgerBook']){const select=$(id),old=select.value;select.replaceChildren();if(!state.registry.books.length){const o=el('option',null,'先添加一部小说');o.value='';select.append(o);}for(const b of state.registry.books){const o=el('option',null,b.title);o.value=b.id;select.append(o);}if(state.registry.books.some(b=>b.id===old))select.value=old;}}
function renderReports(info){
  const report=state.report;$('reportMeta').textContent=report?'北京时间 '+dateLabel(report.checked_at)+' · 清单版本 '+report.registry_revision:'尚未生成或读取远端报告';$('reportNotice').textContent=info.label+(info.fresh?'。下方为夜间任务写回的结果。':'。此处保留原始报告日期；实时核验结果在工作台。');$('reportNotice').className='notice'+(info.fresh?'':' warning');$('reportResults').replaceChildren();
  for(const r of report?.results||[]){const card=el('article','card report-item'),text=el('div');text.append(el('h3',null,r.title),el('p',null,r.reason),el('small',null,'核验时间 '+dateLabel(r.checked_at)+(r.commit?' · 提交 '+r.commit.slice(0,9):'')));card.append(text,badge(r.status));$('reportResults').append(card);}
}
async function readReport(){
  if(!state.client)throw new HubError('先在设置中连接管理仓库。');
  const snap=await state.client.snapshot(config.branch||'');const file=await state.client.optionalJSON('reports/latest.json',snap.commit);state.report=file?validateReport(file.data):null;await render();return state.report;
}
async function readRemote(discard=false){
  if(!state.client)throw new HubError('先在设置中连接管理仓库。');ensureMutable();
  const remote=await loadRegistry(state.client,config.branch||'');
  if(state.dirty&&!discard){if(state.pendingBase){if(remote.registry.books.length&&!await confirmAction('远端有 '+remote.registry.books.length+' 部小说。准备保留当前导入清单，之后保存会替换远端名单，是否继续？')){state.remoteLoaded=false;throw new HubError('未绑定远端版本，本地草稿仍保留。');}state.baseFileHash=remote.fileHash;state.pendingBase=false;persist();}notice('远端连接正常，保留本机未保存修改。保存时会核对原清单版本。');state.remoteLoaded=true;await readReport();return;}
  state.registry=remote.registry;state.baseFileHash=remote.fileHash;state.remoteLoaded=true;state.dirty=false;state.pendingBase=false;state.lastSaved=remote.registry.updated_at;config.branch=remote.branch;localWrite(CONFIG,config);persist();
  notice(remote.missing?'管理仓库已连接，尚无 books.json。添加小说后首次保存即可创建。':'已读取远端小说清单。');await readReport();
}
action($('loadRemote'),async()=>{if(state.dirty&&!await confirmAction('重新读取将替换本机未保存的清单，是否继续？'))return;await readRemote(true);});
action($('refreshReport'),async()=>{await readReport();toast('已读取远端报告；请查看日期与清单版本。');});
action($('saveBooks'),async()=>{
  if(!state.client||!state.client.canWrite){setView('settings');$('writeToken').focus();throw new HubError('保存需要当前会话的 GitHub 写入凭证，请在设置中填写。');}
  if(!state.remoteLoaded)throw new HubError('先读取管理仓库，确认远端清单版本后再保存。');
  ensureMutable();state.saving=true;await render();
  try{const result=await saveRegistry(state.client,state.registry,{branch:config.branch,baseFileHash:state.baseFileHash});state.registry=result.registry;state.baseFileHash=result.fileHash;state.dirty=false;state.lastSaved=result.registry.updated_at;let localError='';try{persist();}catch(e){localError=' 但本机备份失败：'+e.message;}notice('已写入 GitHub 并回读核对。清单已生效，定时计划仍在 GPT 中管理。'+localError,!!localError);toast('清单已保存到 GitHub。');}
  catch(e){notice(e.message+' 本地修改仍保留；写入结果不明时请先重新读取核实。',true);throw e;}
  finally{state.saving=false;await render();}
});
$('bookSearch').addEventListener('input',()=>render());document.querySelectorAll('[data-filter]').forEach(b=>action(b,()=>{state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));render();}));
action($('checkNow'),async()=>{if(state.checking)return;if(!state.registry.books.length)throw new HubError('先添加小说。');state.checking=true;$('checkNow').disabled=true;const registry=structuredClone(state.registry);try{state.live=await inspectRegistry(registry,{onProgress:(done,total)=>{$('checkNow').textContent='核验中 '+done+'/'+total;}});await render();notice('实时结果已核验，仅保存在当前页面；远端日报由总检查任务写入。');}finally{state.checking=false;$('checkNow').disabled=false;$('checkNow').textContent='↻ 实时核验仓库';}});
function openBookDialog(book=null){ensureMutable();state.editing=book?.id||null;$('bookForm').reset();$('bookDialogTitle').textContent=book?'编辑小说':'添加一部小说';$('bookRepo').value=book?.repository_url||'';$('bookName').value=book?.title||'';$('bookBranch').value=book?.branch||'';$('bookChat').value=book?prefs.chats[book.id]||'':'';$('bookTime').value=book?.expected_time||'09:00';$('bookGrace').value=book?.grace_minutes??60;$('bookStart').value=book?.effective_from||tomorrow();$('bookEnabled').checked=book?.enabled??true;$('bookFormError').hidden=true;$('bookDialog').showModal();}
action($('addBook'),()=>openBookDialog());action($('emptyAdd'),()=>openBookDialog());
const addGate=new RequestGate();$('bookDialog').addEventListener('close',()=>addGate.cancel());
$('bookForm').addEventListener('submit',async event=>{
  event.preventDefault();const ticket=addGate.start();$('submitBook').disabled=true;$('bookFormError').hidden=true;
  try{ensureMutable();const repo=parseRepository($('bookRepo').value),branch=safeBranch($('bookBranch').value),chat=validateChatURL($('bookChat').value),book=await loadBook(new GitHubClient(repo.url),branch);if(!ticket.current())return;
    const prior=state.registry.books.find(b=>b.id===state.editing);if(prior?.book_id&&book.manifest.book.id!==prior.book_id)throw new HubError('这个链接的作品身份与原小说不同，请单独添加新书。');
    const entry={id:prior?.id||randomId(),book_id:book.manifest.book.id,title:$('bookName').value.trim()||book.manifest.book.title,repository_url:repo.url,branch,enabled:$('bookEnabled').checked,expected_time:$('bookTime').value,grace_minutes:Number($('bookGrace').value),effective_from:$('bookStart').value,baseline:prior?.baseline||{chapter_count:book.manifest.chapters.length,commit:book.snapshot.commit,captured_at:new Date().toISOString()}};
    const books=prior?state.registry.books.map(b=>b.id===prior.id?entry:b):[...state.registry.books,entry];state.registry=validateRegistry({...state.registry,books});prefs.chats[entry.id]=chat;persistPrivate();changed();$('bookDialog').close();setView('dashboard');toast('已加入本地清单，请点击底部“保存到 GitHub”。');
  }catch(e){if(ticket.current()){$('bookFormError').textContent=e.message;$('bookFormError').hidden=false;}}finally{$('submitBook').disabled=false;}
});
function openChat(book){const url=validateChatURL(prefs.chats[book.id]||'');if(!url){openBookDialog(book);throw new HubError('先填写这部小说对应的 GPT 聊天链接。');}window.open(url,'_blank','noopener,noreferrer');}
async function bookAction(book,value){
  if(value==='schedule')showText('本书每日写作任务指令',writingPrompt(book,config.repository_url));
  if(value==='repair')showText('恢复未完成章节',repairPrompt(book));
  if(value==='code'){setView('delivery');$('deliveryBook').value=book.id;await generateCode();}
  if(value==='pause')showText('停更步骤','1. 打开本书 GPT 聊天或 Scheduled 页面，暂停对应每日更新计划。\n2. 正在运行的任务须另外停止；取消计划不等于停止当前执行。\n3. 回到个人端取消本书检查勾选，再点击“保存到 GitHub”。\n\n本书：'+book.title+'\n聊天：'+(prefs.chats[book.id]||'尚未填写')+'\n网页不会直接取消 ChatGPT 计划。');
  if(value==='remove'){ensureMutable();if(await confirmAction('仅将《'+book.title+'》移出检查清单，不删除仓库或正文。是否继续？')){state.registry.books=state.registry.books.filter(b=>b.id!==book.id);changed();}}
}
action($('copyChecker'),()=>{if(!config.repository_url)throw new HubError('先设置管理仓库。');showText('每天 20:00 总检查任务',checkerPrompt(config.repository_url,config.branch));});
action($('textCopy'),async()=>{await copyText($('textContent').value);toast('内容已复制。');});

let reading=null,readTicket=0,chapterTicket=0;
function disableReading(){for(const id of ['readCopy','readExport','readPrev','readNext'])$(id).disabled=true;}
async function openReader(entry){
  const ticket=++readTicket;chapterTicket++;reading=null;disableReading();$('readBookTitle').textContent=entry.title;$('readTitle').textContent='正在读取目录…';$('readMeta').textContent='';$('readStatus').textContent='';$('readText').textContent='';$('readChapters').replaceChildren();if(!$('readDialog').open)$('readDialog').showModal();
  try{const client=new GitHubClient(entry.repository_url),book=await loadBook(client,entry.branch);if(ticket!==readTicket||!$('readDialog').open)return;if(entry.book_id&&entry.book_id!==book.manifest.book.id)throw new HubError('作品身份改变，请先核对。');reading={client,book,entry,chapter:null,text:null};$('readMeta').textContent=book.manifest.chapters.length+' 章 · 提交 '+book.snapshot.commit.slice(0,9)+' · 正式采用正文';$('readBookTitle').textContent=book.manifest.book.title;renderChapters();if(book.manifest.chapters.length)await readChapter(book.manifest.chapters[0]);else{$('readTitle').textContent='还没有正式章节';$('readStatus').textContent='先在 GPT 完成平台、选题和正文采用。';}}
  catch(e){if(ticket===readTicket){$('readTitle').textContent='无法读取';$('readStatus').textContent=e.message;}}
}
function renderChapters(){$('readChapters').replaceChildren();for(const chapter of reading?.book.manifest.chapters||[]){const b=el('button','chapter-choice'+(reading.chapter?.number===chapter.number?' active':''),'第'+chapter.number+'章 '+chapter.title);action(b,()=>readChapter(chapter));$('readChapters').append(b);}}
async function readChapter(chapter){const current=reading;if(!current)return;const ticket=++chapterTicket;current.text=null;current.chapter=chapter;disableReading();$('readTitle').textContent='第'+chapter.number+'章 '+chapter.title;$('readStatus').textContent='正在核对正文版本…';$('readText').textContent='';renderChapters();try{const text=await readFormalChapter(current.client,current.book,chapter);if(reading!==current||ticket!==chapterTicket)return;current.text=text;$('readText').textContent=text;$('readStatus').textContent='正文 SHA-256 已核对 · '+chapter.han_count+' 汉字'+(chapter.publication_status==='confirmed'?' · 已登记平台发布回执':' · 平台发布尚未登记');$('readCopy').disabled=false;$('readExport').disabled=false;$('readPrev').disabled=chapter.number===1;$('readNext').disabled=chapter.number===current.book.manifest.chapters.length;}catch(e){if(ticket===chapterTicket)$('readStatus').textContent=e.message;}}
$('readDialog').addEventListener('close',()=>{readTicket++;chapterTicket++;reading=null;});
const chapterOutput=()=>{if(!reading||reading.text===null)throw new HubError('正文尚未核验。');return '第'+reading.chapter.number+'章 '+reading.chapter.title+'\n\n'+reading.text;};
action($('readCopy'),async()=>{await copyText(chapterOutput());toast('整章已复制，平台发布仍需实际确认。');});
action($('readExport'),()=>download(chapterOutput(),safeFilename(reading.entry.title+'_第'+reading.chapter.number+'章')));
for(const [id,step] of [['readPrev',-1],['readNext',1]])action($(id),()=>{const c=reading?.book.manifest.chapters[(reading.chapter?.number||0)-1+step];if(c)return readChapter(c);});
action($('readExportAll'),async()=>{const current=reading;if(!current||!current.book.manifest.chapters.length)throw new HubError('没有正式章节。');$('readExportAll').disabled=true;try{const output=[];for(const c of current.book.manifest.chapters){if(reading!==current)throw new HubError('阅读对象已切换，导出已取消。');$('readExportAll').textContent='核对 '+c.number+'/'+current.book.manifest.chapters.length;output.push('第'+c.number+'章 '+c.title+'\n\n'+await readFormalChapter(current.client,current.book,c));}if(reading!==current)throw new HubError('导出已取消。');download(current.book.manifest.book.title+'\n\n'+output.join('\n\n'),safeFilename(current.book.manifest.book.title));toast('完整正文已核验并导出。');}finally{$('readExportAll').disabled=false;$('readExportAll').textContent='导出整本';}});

async function generateCode(){const book=state.registry.books.find(b=>b.id===$('deliveryBook').value);if(!book)throw new HubError('先选择小说。');$('deliveryCode').value=await encodeLocator(book);}
action($('generateCode'),generateCode);$('deliveryBook').addEventListener('change',()=>{$('deliveryCode').value='';});
action($('copyCode'),async()=>{await copyText($('deliveryCode').value);toast('代发码已复制。');});
function readerURL(){return validateReaderURL($('readerBase').value.trim()||new URL('reader.html',location.href).href);}
$('readerBase').value=prefs.reader_url||new URL('reader.html',location.href).href;
action($('saveReaderBase'),()=>{prefs.reader_url=readerURL();persistPrivate();toast('代发网址已保存到本机。');});
action($('copyShareLink'),async()=>{if(!$('deliveryCode').value)await generateCode();await copyText(readerURL()+'#'+$('deliveryCode').value);toast('代发链接已复制；请确认部署网址允许合作人访问。');});

$('managementRepo').value=config.repository_url||'';$('managementBranch').value=config.branch||'';
$('settingsForm').addEventListener('submit',async event=>{
  event.preventDefault();try{ensureMutable();const repo=parseRepository($('managementRepo').value),branch=safeBranch($('managementBranch').value),token=$('writeToken').value.trim();$('writeToken').value='';
    const changedRepo=repo.url!==config.repository_url||branch!==(config.branch||'');if(changedRepo){persist();const carry=state.dirty&&await confirmAction('把当前未保存清单带到新管理仓库？取消则读取该仓库自己的清单；原草稿仍保留本机。')?structuredClone(state.registry):null;state.client?.clearToken();config={repository_url:repo.url,branch};state.registry=blankRegistry();state.dirty=false;state.baseFileHash=null;state.report=null;state.live=null;state.remoteLoaded=false;state.pendingBase=false;restoreDraft();if(carry){state.registry=carry;state.dirty=true;state.baseFileHash=null;state.pendingBase=true;}}
    if(changedRepo||token||!state.client){state.client?.clearToken();state.client=new GitHubClient(repo.url,{token});}
    localWrite(CONFIG,config);$('settingsStatus').textContent=state.client.canWrite?'已应用；会话具备写入凭证，尚需远端确认权限。':'已应用只读连接；保存时需临时填写凭证。';
    await readRemote(false);toast('连接已应用。');
  }catch(e){$('settingsStatus').textContent=e.message;notice(e.message,true);}finally{await render();}
});
action($('clearToken'),()=>{state.client?.clearToken();$('writeToken').value='';$('settingsStatus').textContent='会话凭证已清除，仍可读取公开数据。';toast('凭证已清除。');});
const localTools=el('div','actions'),disconnect=el('button','button ghost small','断开管理仓库'),importButton=el('button','button outline small','导入本机备份'),importInput=el('input');disconnect.type=importButton.type='button';importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;localTools.append(disconnect,importButton,importInput);$('settingsForm').append(localTools);
action(disconnect,()=>{ensureMutable();persist();state.client?.clearToken();state.client=null;config={};localWrite(CONFIG,config);state.remoteLoaded=false;state.baseFileHash=null;state.lastSaved=null;state.report=null;state.live=null;state.pendingBase=true;state.dirty=state.registry.books.length>0;persist();$('managementRepo').value='';$('managementBranch').value='';$('writeToken').value='';$('settingsStatus').textContent='已断开；小说清单仍在本机，远端数据没有变化。';notice('');setView('dashboard');render();});
action(importButton,()=>importInput.click());
importInput.addEventListener('change',async()=>{try{ensureMutable();const file=importInput.files?.[0];if(!file)return;if(file.size>4000000)throw new HubError('备份文件超过4MB。');const backup=validateLocalBackup(JSON.parse(await file.text()));if(!await confirmAction('导入将替换当前本机清单、聊天链接和收益记录，不会立即修改 GitHub。是否继续？'))return;persist();state.client?.clearToken();config=backup.config;prefs={chats:backup.chats,ledger:backup.ledger,reader_url:backup.reader_url};persistPrivate();localWrite(CONFIG,config);state.registry=backup.registry;state.baseFileHash=null;state.dirty=true;state.pendingBase=true;state.remoteLoaded=false;state.report=null;state.live=null;state.lastSaved=null;persist();$('managementRepo').value=config.repository_url||'';$('managementBranch').value=config.branch||'';$('writeToken').value='';$('readerBase').value=prefs.reader_url||new URL('reader.html',location.href).href;state.client=config.repository_url?new GitHubClient(config.repository_url):null;await render();notice('本机备份已导入。需重新读取管理仓库确认版本，再临时授权保存。');if(state.client)await readRemote(false);toast('备份已恢复到本机，没有自动写入远端。');}catch(e){notice('备份处理：'+e.message,true);}finally{importInput.value='';}});
action($('loadHistory'),async()=>{if(!state.client)throw new HubError('先连接管理仓库。');const list=await state.client.json('commits?path=books.json&per_page=5&sha='+encodeURIComponent(config.branch||'HEAD'));if(!Array.isArray(list))throw new HubError('历史记录无法读取。');$('historyResults').replaceChildren();for(const c of list){const row=el('div','history-item');row.append(el('span',null,dateLabel(c.commit?.committer?.date)+' · '+c.sha.slice(0,8)));const b=el('button','button ghost small','恢复到本地');action(b,async()=>{ensureMutable();const file=await state.client.readJSON('books.json',c.sha),restored=validateRegistry(file.data);if(!await confirmAction('将历史清单恢复到本地？还需点击保存才会修改远端。'))return;state.registry=restored;changed();setView('dashboard');toast('已恢复到本地，请核对后保存。');});row.append(b);$('historyResults').append(row);}if(!list.length)$('historyResults').append(el('p','muted','尚无清单历史。'));});
function renderLedger(){const entries=prefs.ledger.filter(x=>x&&Number.isFinite(x.income)&&Number.isFinite(x.expense)&&Number.isFinite(x.minutes));const total=key=>entries.reduce((s,x)=>s+x[key],0);$('ledgerIncome').textContent='¥'+total('income').toLocaleString('zh-CN',{maximumFractionDigits:2});$('ledgerExpense').textContent='¥'+total('expense').toLocaleString('zh-CN',{maximumFractionDigits:2});$('ledgerMinutes').textContent=total('minutes')+' 分钟';$('ledgerList').replaceChildren();for(const item of [...entries].reverse()){const row=el('div','ledger-item'),left=el('div');left.append(el('p',null,item.title+' · '+item.date),el('small',null,item.note||'实际数据记录'));const right=el('div');right.append(el('p',null,'收入 ¥'+item.income+' / 支出 ¥'+item.expense),el('small',null,'人工 '+item.minutes+' 分钟'));const remove=el('button','button ghost small','删除');action(remove,async()=>{if(!await confirmAction('删除这条本机记录？'))return;prefs.ledger=prefs.ledger.filter(x=>x.id!==item.id);persistPrivate();renderLedger();});row.append(left,right,remove);$('ledgerList').append(row);}if(!entries.length)$('ledgerList').append(el('p','muted','还没有实际记录。可填写稿费、代发费用和人工补更耗时。'));}
action($('addLedger'),()=>{if(!state.registry.books.length)throw new HubError('先添加小说。');renderBookOptions();$('ledgerForm').reset();$('ledgerDate').value=dayInShanghai();$('ledgerDialog').showModal();});
$('ledgerForm').addEventListener('submit',event=>{event.preventDefault();try{const book=state.registry.books.find(x=>x.id===$('ledgerBook').value);if(!book)throw new HubError('选择小说。');const income=Number($('incomeInput').value),expense=Number($('expenseInput').value),minutes=Number($('minutesInput').value);if(![income,expense,minutes].every(x=>Number.isFinite(x)&&x>=0&&x<=100000000))throw new HubError('金额或时间无效。');const entry={id:randomId(),book_id:book.id,title:book.title,date:$('ledgerDate').value,income,expense,minutes,note:$('ledgerNote').value.trim().slice(0,300)};const next=[...prefs.ledger,entry];localWrite(PRIVATE,{chats:prefs.chats,ledger:next,reader_url:prefs.reader_url||''});prefs.ledger=next;$('ledgerDialog').close();renderLedger();toast('实际记录已保存到本机。');}catch(e){toast(e.message);}});
action($('exportLocal'),()=>download(JSON.stringify({type:'novel-hub-local-backup-v1',exported_at:new Date().toISOString(),config,registry:state.registry,chats:prefs.chats,ledger:prefs.ledger,reader_url:prefs.reader_url||''},null,2),'续章_本机备份_'+dayInShanghai()+'.json','application/json'));
action($('exportReport'),()=>{if(!state.report)throw new HubError('尚无远端日报可导出。');download(JSON.stringify(state.report,null,2),'更新报告_'+state.report.date+'.json','application/json');});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)render();});
await render();if(config.repository_url){state.client=new GitHubClient(config.repository_url);try{await readRemote(false);}catch(e){notice(e.message+' 已保留本机内容。',true);await render();}}
