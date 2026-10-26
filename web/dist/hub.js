import {GitHubClient,HubError,SYSTEM_REPOSITORY,parseRepository,safeBranch,blankRegistry,validateRegistry,registryFingerprint,validateChatURL,dayInShanghai,tomorrow,loadRegistry,saveRegistry,validateReport,reportState,inspectRegistry,loadBook,readFormalChapter,encodeLocator,STATUS,writingPrompt,repairPrompt,checkerPrompt,randomId,validateReaderURL,validateLocalBackup} from './hub-core.mjs';
import {AutoSync,mergeRegistries} from './auto-sync.mjs';
import {safeFilename,RequestGate} from './core.mjs';
import {$,el,toast,localRead,localWrite,dateLabel,copyText,download,action,confirmAction} from './ui.mjs';

const CONFIG='novel-hub-config-v1',PRIVATE='novel-hub-private-v1',AUTH='novel-hub-auth-v1:';
let config=localRead(CONFIG,{});try{config={repository_url:parseRepository(config.repository_url||SYSTEM_REPOSITORY).url,branch:safeBranch(config.branch||'main')};}catch{config={repository_url:SYSTEM_REPOSITORY,branch:'main'};}
const legacy=localRead(PRIVATE,{chats:{},reader_url:''});
const spaceKey=()=> 'novel-hub-draft-v1:'+parseRepository(config.repository_url).key+':'+(config.branch||'default');
const authKey=()=>AUTH+parseRepository(config.repository_url).key;
function storedToken(){try{return sessionStorage.getItem(authKey())||localStorage.getItem(authKey())||'';}catch{return '';}}
function rememberCredential(token,remember){try{if(token)sessionStorage.setItem(authKey(),token);else sessionStorage.removeItem(authKey());if(remember&&token)localStorage.setItem(authKey(),token);else localStorage.removeItem(authKey());}catch{toast('授权未能保存在浏览器中，本次页面仍可同步。');}}
const state={registry:blankRegistry(),baseRegistry:null,baseFileHash:null,remoteLoaded:false,dirty:false,report:null,reportError:'',live:null,saving:false,checking:false,filter:'all',editing:null,client:new GitHubClient(config.repository_url,{token:storedToken()}),syncStatus:'loading',lastSaved:null,view:'dashboard'};
const draft=localRead(spaceKey(),null)||localRead('novel-hub-draft-v1:'+parseRepository(config.repository_url).key+':default',null)||localRead('novel-hub-draft-v1:unbound:default',null);
if(draft){try{state.registry=validateRegistry(draft.registry);state.baseFileHash=draft.baseFileHash||null;state.baseRegistry=draft.baseRegistry?validateRegistry(draft.baseRegistry):null;state.dirty=draft.dirty===true||!draft.baseRegistry;state.lastSaved=draft.lastSaved||null;}catch{toast('旧本机缓存格式异常，将读取 GitHub 清单。');}}
for(const book of state.registry.books)if(!book.chat_url&&legacy.chats?.[book.id]){try{book.chat_url=validateChatURL(legacy.chats[book.id]);state.dirty=true;}catch{}}
if(!state.registry.settings?.reader_url&&legacy.reader_url){try{state.registry.settings={reader_url:validateReaderURL(legacy.reader_url)};state.dirty=true;}catch{}}

function persist(){try{localWrite(spaceKey(),{registry:state.registry,baseRegistry:state.baseRegistry,baseFileHash:state.baseFileHash,dirty:state.dirty,lastSaved:state.lastSaved});}catch(e){notice(e.message,true);}}
function notice(message,error=false){$('globalNotice').hidden=!message;$('globalNotice').textContent=message;$('globalNotice').className='notice'+(error?' error':'');}
function ensureConnectionMutable(){if(sync.running)throw new HubError('正在同步，请稍后修改连接。');}
const sync=new AutoSync({snapshot:()=>structuredClone(state.registry),canSave:()=>state.remoteLoaded&&state.client.canWrite,save:value=>saveRegistry(state.client,value,{branch:config.branch,baseFileHash:state.baseFileHash}),onCommit:(result,current)=>{
  state.baseFileHash=result.fileHash;state.baseRegistry=result.registry;state.lastSaved=result.registry.updated_at;
  state.registry=current?result.registry:{...state.registry,revision:result.registry.revision,updated_at:result.registry.updated_at};state.dirty=!current;persist();
},onStatus:(status,error)=>{state.syncStatus=status;state.saving=status==='saving';if(status==='error')notice(error.message+' 修改已留在本机，请点击“重试同步”。',true);if(status==='saved')notice('已自动保存到 GitHub。');render();}});
function changed(){state.registry=validateRegistry(state.registry);state.dirty=true;persist();sync.touch();render();}
const labels={dashboard:['我的小说','我的小说。','点击书名看正文，新增和修改自动保存到 GitHub。'],reading:['阅读正文','接着读下去。','从已加入的小说中选择，直接阅读、复制和导出。'],delivery:['小说代发码','选择小说，就有代发码。','把代发链接交给合作人，文章随仓库更新。'],reports:['检查报告','今天，更新了吗？','读取 GitHub 中的检查结果，处理需要补更的小说。'],settings:['同步设置','一次授权，自动保存。','GitHub 保存清单与设置，打开软件自动读取。']};
function setView(name,open=true){if(!labels[name])return;state.view=name;for(const key of Object.keys(labels))$(key+'View').hidden=key!==name;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$('viewLabel').textContent=labels[name][0];$('pageTitle').textContent=labels[name][1];$('pageSubtitle').textContent=labels[name][2];if(name==='delivery')generateCode();if(name==='reading'&&open){const b=selectedBook('readBookSelect');if(b&&reading?.entry.id!==b.id)openReader(b);}}
function selectedBook(id){return state.registry.books.find(b=>b.id===$(id).value)||state.registry.books[0];}
function showText(title,text){$('textTitle').textContent=title;$('textContent').value=text;$('textDialog').showModal();}
document.querySelectorAll('[data-view]').forEach(b=>action(b,()=>setView(b.dataset.view)));
document.querySelectorAll('[data-close]').forEach(b=>action(b,()=>$(b.dataset.close).close()));
for(const id of ['connectionLabel','authorizeSync'])action($(id),()=>{setView('settings');$('writeToken').focus();});
const badge=status=>el('span','badge '+(status||'unknown'),STATUS[status]||'待检查');
let renderSeq=0,optionSignature='';
function renderOptions(){
  const signature=JSON.stringify(state.registry.books.map(b=>[b.id,b.title]));if(signature===optionSignature)return;optionSignature=signature;
  for(const id of ['deliveryBook','readBookSelect']){const select=$(id),old=select.value;select.replaceChildren();if(!state.registry.books.length){const o=el('option',null,'先添加一部小说');o.value='';select.append(o);}for(const b of state.registry.books){const o=el('option',null,b.title);o.value=b.id;select.append(o);}if(state.registry.books.some(b=>b.id===old))select.value=old;}
  generateCode();
}
async function render(){
  const seq=++renderSeq,registry=state.registry,fp=await registryFingerprint(registry);if(seq!==renderSeq)return;
  const report=await reportState(state.report,registry);if(seq!==renderSeq)return;
  const liveGood=state.live?.date===dayInShanghai()&&state.live.registry_fingerprint===fp,current=liveGood?state.live:report.fresh?state.report:null,results=new Map((current?.results||[]).map(r=>[r.id,r]));
  $('selectedCount').replaceChildren(document.createTextNode(registry.books.filter(b=>b.enabled).length),el('small',null,'部'));
  $('updatedCount').textContent=current?current.results.filter(r=>r.status==='updated').length:'—';$('attentionCount').textContent=current?current.results.filter(r=>['missing','pending','unknown','setup'].includes(r.status)).length:'—';$('updatedHint').textContent=liveGood?'刚刚核对仓库':report.fresh?'依据今日报告':'等待检查结果';$('latestCheck').textContent=current?dateLabel(current.checked_at,true):'—';$('reportFreshness').textContent=liveGood?'实时检查结果':report.label;
  const canWrite=state.client.canWrite;
  $('connectionLabel').textContent=state.saving?'正在自动保存…':state.dirty?(state.syncStatus==='error'?'同步失败 · 查看设置':canWrite?'有修改待同步':'启用 GitHub 自动保存'):state.remoteLoaded?'GitHub 已连接':state.syncStatus==='error'?'GitHub 连接失败 · 重试':'正在读取 GitHub…';
  $('saveIndicator').textContent=state.saving?'● 正在自动保存':state.dirty?(state.syncStatus==='error'?'● 保存未完成':canWrite?'● 等待自动同步':'● 待授权保存'):state.lastSaved?'● GitHub 已保存 '+dateLabel(state.lastSaved):state.remoteLoaded?'● GitHub 已读取':'● 尚未读取 GitHub';$('saveIndicator').classList.toggle('dirty',state.dirty);
  $('saveHint').textContent=state.dirty&&!canWrite?'授权后会自动保存当前修改，无需重新添加小说。':'新增、编辑、勾选都会自动同步；再次打开读取 GitHub。';$('retrySync').hidden=state.syncStatus!=='error';$('retrySync').disabled=state.saving;$('authorizeSync').hidden=canWrite;
  $('bookRows').replaceChildren();const q=$('bookSearch').value.trim().toLowerCase();let visible=0;
  for(const book of registry.books){
    const result=!book.enabled?{status:'paused',reason:'不参与检查'}:results.get(book.id);if(q&&!book.title.toLowerCase().includes(q))continue;if(state.filter==='enabled'&&!book.enabled)continue;if(state.filter==='attention'&&!['missing','pending','unknown','setup'].includes(result?.status))continue;
    visible++;const row=el('tr'),td=el('td'),check=el('input');check.type='checkbox';check.checked=book.enabled;check.setAttribute('aria-label','检查《'+book.title+'》');check.addEventListener('change',()=>{state.registry.books=state.registry.books.map(b=>b.id===book.id?{...b,enabled:check.checked}:b);changed();});td.append(check);row.append(td);
    const titleTd=el('td'),cell=el('div','book-cell'),title=el('button','book-open book-title',book.title);action(title,()=>openReader(book));const words=el('div');words.append(title,el('span','book-meta',Number.isInteger(result?.chapters)?result.chapters+' 章':book.baseline?book.baseline.chapter_count+' 章':'待读取章节'));cell.append(el('span','book-avatar',book.title.slice(0,1)),words);titleTd.append(cell);row.append(titleTd);
    const time=el('td');time.append(el('div',null,book.expected_time),el('span','book-meta','北京时间'));row.append(time);const statusTd=el('td');statusTd.append(badge(result?.status),el('span','status-note',result?.reason||'尚无今日检查结果'));row.append(statusTd);
    const actionsTd=el('td'),actions=el('div','row-actions');for(const [label,fn] of [['查看正文',()=>openReader(book)],['代发码',()=>{setView('delivery');$('deliveryBook').value=book.id;generateCode();}],['编辑',()=>openBookDialog(book)]]){const button=el('button',null,label);action(button,fn);actions.append(button);}
    const menu=el('select');menu.setAttribute('aria-label','《'+book.title+'》更多操作');for(const [value,label] of [['','更多'],['chat','打开 GPT'],['schedule','定时指令'],['repair','补更指令'],['remove','移出清单']]){const o=el('option',null,label);o.value=value;menu.append(o);}menu.addEventListener('change',()=>{const value=menu.value;menu.value='';bookAction(book,value).catch(e=>toast(e.message));});actions.append(menu);actionsTd.append(actions);row.append(actionsTd);$('bookRows').append(row);
  }
  $('booksEmpty').hidden=visible>0;renderOptions();renderReports(report);
}
function renderReports(info){$('reportMeta').textContent=state.report?dateLabel(state.report.checked_at)+' · 清单版本 '+state.report.registry_revision:'尚无远端报告';$('reportNotice').textContent=state.reportError||info.label;$('reportNotice').className='notice'+(info.fresh?'':' warning');$('reportResults').replaceChildren();for(const r of state.report?.results||[]){const card=el('article','card report-item'),text=el('div');text.append(el('h3',null,r.title),el('p',null,r.reason));card.append(text,badge(r.status));$('reportResults').append(card);}}
async function readReport(){try{const snap=await state.client.snapshot(config.branch),file=await state.client.optionalJSON('reports/latest.json',snap.commit);state.report=file?validateReport(file.data):null;state.reportError='';}catch(e){state.reportError='报告暂时无法读取：'+e.message;}await render();}
function payload(registry){return JSON.stringify({books:registry.books,settings:registry.settings||{}});}
async function readRemote({initial=false,replace=false}={}){
  if(sync.running)return;const remote=await loadRegistry(state.client,config.branch);config.branch=remote.branch;localWrite(CONFIG,config);
  if(state.dirty&&!replace){
    if(payload(remote.registry)===payload(state.registry)){state.registry=remote.registry;state.dirty=false;sync.acknowledge();}
    else if(state.baseFileHash!==remote.fileHash){
      const merged=mergeRegistries(remote.registry,state.registry,state.baseRegistry);
      if(merged.conflicts.length){state.remoteLoaded=true;state.syncStatus='error';throw new HubError('GitHub 与本机有同一本书的不同修改。请先导出备份，再刷新选择需要的版本。','conflict');}
      state.registry=validateRegistry(merged.registry);state.dirty=payload(state.registry)!==payload(remote.registry);if(!state.dirty)sync.acknowledge();
    }
  }else{state.registry=remote.registry;state.dirty=false;sync.acknowledge();}
  state.baseFileHash=remote.fileHash;state.baseRegistry=remote.registry;state.remoteLoaded=true;state.lastSaved=remote.registry.updated_at;persist();
  $('readerBase').value=state.registry.settings?.reader_url||legacy.reader_url||new URL('reader.html',location.href).href;
  if(state.dirty){if(!sync.dirty)sync.touch();if(initial)sync.flush();}else state.syncStatus='saved';
  await render();await readReport();
}
action($('loadRemote'),async()=>{if(state.dirty&&!await confirmAction('本机有尚未同步的修改。是否采用 GitHub 版本替换？取消可先导出备份。'))return;await readRemote({replace:true});toast('已读取 GitHub 最新清单。');});
action($('retrySync'),async()=>{try{await readRemote();if(state.dirty)await sync.retry();}catch(e){notice(e.message,true);}});
action($('refreshReport'),readReport);
action($('checkNow'),async()=>{if(state.checking)return;if(!state.registry.books.length)throw new HubError('先添加小说。');state.checking=true;$('checkNow').disabled=true;try{state.live=await inspectRegistry(structuredClone(state.registry),{onProgress:(n,total)=>$('checkNow').textContent='检查 '+n+'/'+total});await render();}finally{state.checking=false;$('checkNow').disabled=false;$('checkNow').textContent='检查今天更新';}});
$('bookSearch').addEventListener('input',render);document.querySelectorAll('[data-filter]').forEach(b=>action(b,()=>{state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));render();}));
function openBookDialog(book=null){state.editing=book?.id||null;$('bookForm').reset();$('bookDialogTitle').textContent=book?'编辑小说':'添加小说';$('bookRepo').value=book?.repository_url||'';$('bookName').value=book?.title||'';$('bookBranch').value=book?.branch||'';$('bookChat').value=book?.chat_url||legacy.chats?.[book?.id]||'';$('bookTime').value=book?.expected_time||'09:00';$('bookGrace').value=book?.grace_minutes??60;$('bookStart').value=book?.effective_from||tomorrow();$('bookEnabled').checked=book?.enabled??true;$('submitBook').textContent=book?'保存修改':'添加并打开正文';$('bookFormError').hidden=true;$('bookDialog').showModal();}
for(const id of ['addBook','emptyAdd'])action($(id),()=>openBookDialog());
const addGate=new RequestGate();$('bookDialog').addEventListener('close',()=>addGate.cancel());
$('bookForm').addEventListener('submit',async event=>{
  event.preventDefault();const ticket=addGate.start();$('submitBook').disabled=true;$('submitBook').textContent='读取小说中…';$('bookFormError').hidden=true;
  try{const repo=parseRepository($('bookRepo').value),branch=safeBranch($('bookBranch').value),chat=validateChatURL($('bookChat').value),client=new GitHubClient(repo.url),book=await loadBook(client,branch);if(!ticket.current())return;
    const prior=state.registry.books.find(b=>b.id===state.editing);if(prior?.book_id&&prior.book_id!==book.manifest.book.id)throw new HubError('这不是原来的小说，请单独添加。');
    const entry={id:prior?.id||randomId(),book_id:book.manifest.book.id,title:$('bookName').value.trim()||book.manifest.book.title,repository_url:repo.url,branch,enabled:$('bookEnabled').checked,expected_time:$('bookTime').value,grace_minutes:Number($('bookGrace').value),effective_from:$('bookStart').value,baseline:prior?.baseline||{chapter_count:book.manifest.chapters.length,commit:book.snapshot.commit,captured_at:new Date().toISOString()},...(chat?{chat_url:chat}:{})};
    state.registry=validateRegistry({...state.registry,books:prior?state.registry.books.map(b=>b.id===prior.id?entry:b):[...state.registry.books,entry]});changed();$('bookDialog').close();await openReader(entry,{client,book});toast(state.client.canWrite?'已加入，正在自动保存到 GitHub。':'已加入并打开正文；启用自动保存后会同步到 GitHub。');
  }catch(e){if(ticket.current()){$('bookFormError').textContent=e.message;$('bookFormError').hidden=false;}}finally{$('submitBook').disabled=false;$('submitBook').textContent='添加并打开正文';}
});
async function bookAction(book,value){if(value==='chat'){const url=validateChatURL(book.chat_url||legacy.chats?.[book.id]||'');if(!url){openBookDialog(book);return;}window.open(url,'_blank','noopener,noreferrer');}if(value==='schedule')showText('本书定时写作指令',writingPrompt(book,config.repository_url));if(value==='repair')showText('补更指令',repairPrompt(book));if(value==='remove'&&await confirmAction('把《'+book.title+'》移出小说清单？不会删除仓库或正文。')){state.registry.books=state.registry.books.filter(b=>b.id!==book.id);changed();if(reading?.entry.id===book.id){reading=null;$('readText').textContent='';$('readTitle').textContent='这部小说已移出清单';disableReading();}}}
action($('copyChecker'),()=>showText('每天20:00总检查任务',checkerPrompt(config.repository_url,config.branch)));action($('textCopy'),async()=>{await copyText($('textContent').value);toast('已复制。');});

let reading=null,readTicket=0,chapterTicket=0;
function disableReading(){for(const id of ['readCopy','readExport','readPrev','readNext','readExportAll'])$(id).disabled=true;}
async function openReader(entry,loaded=null){
  renderOptions();setView('reading',false);$('readBookSelect').value=entry.id;const ticket=++readTicket;chapterTicket++;reading=null;disableReading();$('readBookTitle').textContent=entry.title;$('readTitle').textContent='读取目录中…';$('readMeta').textContent='';$('readStatus').textContent='';$('readText').textContent='';$('readChapters').replaceChildren();
  try{const client=loaded?.client||new GitHubClient(entry.repository_url),book=loaded?.book||await loadBook(client,entry.branch);if(ticket!==readTicket)return;if(entry.book_id&&entry.book_id!==book.manifest.book.id)throw new HubError('作品身份已改变，请核对仓库。');reading={client,book,entry,chapter:null,text:null};$('readBookTitle').textContent=book.manifest.book.title;$('readMeta').textContent=book.manifest.chapters.length+'章 · 最新提交 '+book.snapshot.commit.slice(0,9);renderChapters();if(book.manifest.chapters.length){$('readExportAll').disabled=false;await readChapter(book.manifest.chapters[0]);}else{$('readTitle').textContent='还没有正式章节';$('readStatus').textContent='等待 GPT 完成创作和采用正文。';}}
  catch(e){if(ticket===readTicket){$('readTitle').textContent='暂时无法读取正文';$('readStatus').textContent=e.message;}}
}
$('readBookSelect').addEventListener('change',()=>{const b=selectedBook('readBookSelect');if(b)openReader(b);});action($('readRefresh'),()=>{const b=selectedBook('readBookSelect');if(b)return openReader(b);throw new HubError('先添加小说。');});
function renderChapters(){$('readChapters').replaceChildren();for(const c of reading?.book.manifest.chapters||[]){const b=el('button','chapter-choice'+(reading.chapter?.number===c.number?' active':''),'第'+c.number+'章 '+c.title);action(b,()=>readChapter(c));$('readChapters').append(b);}}
async function readChapter(chapter){const current=reading;if(!current)return;const ticket=++chapterTicket;current.text=null;current.chapter=chapter;disableReading();$('readTitle').textContent='第'+chapter.number+'章 '+chapter.title;$('readStatus').textContent='正在校验正文…';$('readText').textContent='';renderChapters();try{const text=await readFormalChapter(current.client,current.book,chapter);if(reading!==current||ticket!==chapterTicket)return;current.text=text;$('readText').textContent=text;$('readStatus').textContent=chapter.han_count+'汉字 · 正文校验通过';$('readCopy').disabled=false;$('readExport').disabled=false;$('readExportAll').disabled=false;$('readPrev').disabled=chapter.number===1;$('readNext').disabled=chapter.number===current.book.manifest.chapters.length;}catch(e){if(ticket===chapterTicket)$('readStatus').textContent=e.message;}}
const chapterOutput=()=>{if(!reading||reading.text===null)throw new HubError('正文尚未读取并核验。');return '第'+reading.chapter.number+'章 '+reading.chapter.title+'\n\n'+reading.text;};
action($('readCopy'),async()=>{await copyText(chapterOutput());toast('整章已复制。');});action($('readExport'),()=>download(chapterOutput(),safeFilename(reading.entry.title+'_第'+reading.chapter.number+'章')));
for(const [id,step] of [['readPrev',-1],['readNext',1]])action($(id),()=>{const c=reading?.book.manifest.chapters[(reading.chapter?.number||0)-1+step];if(c)return readChapter(c);});
action($('readExportAll'),async()=>{const current=reading;if(!current?.book.manifest.chapters.length)throw new HubError('没有正式章节。');$('readExportAll').disabled=true;try{const output=[];for(const c of current.book.manifest.chapters){if(reading!==current)throw new HubError('小说已切换，导出取消。');$('readExportAll').textContent='核对 '+c.number+'/'+current.book.manifest.chapters.length;output.push('第'+c.number+'章 '+c.title+'\n\n'+await readFormalChapter(current.client,current.book,c));}if(reading!==current)throw new HubError('导出取消。');download(current.book.manifest.book.title+'\n\n'+output.join('\n\n'),safeFilename(current.book.manifest.book.title));}finally{$('readExportAll').disabled=!reading?.text;$('readExportAll').textContent='导出整本';}});

let codeTicket=0;
async function generateCode(){const ticket=++codeTicket,book=selectedBook('deliveryBook');$('deliveryCode').value='';if(!book)return '';const code=await encodeLocator(book);if(ticket!==codeTicket||selectedBook('deliveryBook')?.id!==book.id)return '';$('deliveryCode').value=code;return code;}
$('deliveryBook').addEventListener('change',generateCode);action($('copyCode'),async()=>{const code=await generateCode();if(!code)throw new HubError('先添加并选择小说。');await copyText(code);toast('代发码已复制。');});
function readerURL(){return validateReaderURL(state.registry.settings?.reader_url||legacy.reader_url||new URL('reader.html',location.href).href);}
action($('copyShareLink'),async()=>{const code=await generateCode();if(!code)throw new HubError('先选择小说。');await copyText(readerURL()+'#'+code);toast('代发链接已复制。');});
action($('saveReaderBase'),()=>{state.registry.settings={reader_url:validateReaderURL($('readerBase').value.trim())};changed();toast('代发网址已修改，正在自动同步。');});

$('managementRepo').value=config.repository_url;$('managementBranch').value=config.branch;try{$('rememberToken').checked=!!localStorage.getItem(authKey());}catch{}
$('settingsForm').addEventListener('submit',async event=>{
  event.preventDefault();try{ensureConnectionMutable();const next={repository_url:parseRepository($('managementRepo').value).url,branch:safeBranch($('managementBranch').value)},different=next.repository_url!==config.repository_url||next.branch!==config.branch,token=$('writeToken').value.trim()||(!different?storedToken():'');$('writeToken').value='';if(!token)throw new HubError('填写此管理仓库的 GitHub 写入凭证后即可自动保存。');
    if(different&&state.dirty)throw new HubError('先同步当前修改，或导出备份后再切换仓库。');state.client.clearToken();config=next;rememberCredential(token,$('rememberToken').checked);localWrite(CONFIG,config);state.client=new GitHubClient(config.repository_url,{token});state.remoteLoaded=false;if(different){state.registry=blankRegistry();state.baseFileHash=null;state.baseRegistry=null;sync.acknowledge();}
    await readRemote();if(state.dirty){if(!sync.dirty)sync.touch();await sync.retry();}$('settingsStatus').textContent=state.dirty?'修改尚未同步，请查看上方提示。':'自动同步已启用。新增、编辑与勾选会自动保存。';await render();
  }catch(e){$('settingsStatus').textContent=e.message;notice(e.message,true);}
});
action($('clearToken'),()=>{ensureConnectionMutable();state.client.clearToken();rememberCredential('',false);$('writeToken').value='';$('rememberToken').checked=false;$('settingsStatus').textContent='已清除授权，现有 GitHub 数据仍可读取。';render();});
action($('exportLocal'),()=>download(JSON.stringify({type:'novel-hub-local-backup-v1',exported_at:new Date().toISOString(),config,registry:state.registry,chats:Object.fromEntries(state.registry.books.filter(b=>b.chat_url).map(b=>[b.id,b.chat_url])),reader_url:state.registry.settings?.reader_url||''},null,2),'续章_清单备份_'+dayInShanghai()+'.json','application/json'));
const importInput=el('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;document.body.append(importInput);action($('importLocal'),()=>importInput.click());
importInput.addEventListener('change',async()=>{try{const file=importInput.files?.[0];if(!file)return;if(file.size>4000000)throw new HubError('备份超过4MB。');const backup=validateLocalBackup(JSON.parse(await file.text()));const incoming={...backup.registry,books:backup.registry.books.map(b=>({...b,...(b.chat_url||backup.chats[b.id]?{chat_url:b.chat_url||backup.chats[b.id]}:{})}))};const merged=mergeRegistries(state.registry,incoming);if(merged.conflicts.length)throw new HubError('备份和当前清单存在同书不同设置，请先编辑核对。');state.registry=validateRegistry(merged.registry);if(!state.registry.settings?.reader_url&&backup.reader_url)state.registry.settings={reader_url:backup.reader_url};changed();toast('备份已合并到当前清单，自动同步已排队。');}catch(e){notice(e.message,true);}finally{importInput.value='';}});
action($('exportReport'),()=>{if(!state.report)throw new HubError('尚无报告。');download(JSON.stringify(state.report,null,2),'更新报告_'+state.report.date+'.json','application/json');});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
let lastRefresh=0;document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.dirty&&!sync.running&&Date.now()-lastRefresh>60000){lastRefresh=Date.now();readRemote().catch(e=>notice('刷新失败，仍显示上次内容：'+e.message,true));}});
if(state.dirty)sync.touch();await render();try{await readRemote({initial:true});}catch(e){state.syncStatus='error';notice('GitHub 暂时未能读取，已保留本机内容：'+e.message,true);await render();}
