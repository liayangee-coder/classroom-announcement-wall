'use strict';
const STORAGE_KEY = 'emily-announcement-wall-v1';
const themes = {
  forest: {name:'鼠尾草綠', note:'自然・舒心', accent:'#3c7463', background:'#e6efe9'},
  ocean: {name:'晴空藍', note:'清爽・明亮', accent:'#426bb2', background:'#e6edf8'},
  apricot: {name:'杏桃暖橘', note:'親切・溫暖', accent:'#aa603d', background:'#fae8d9'},
  plum: {name:'薰衣草紫', note:'柔和・優雅', accent:'#765891', background:'#eee5f3'},
  rose: {name:'乾燥玫瑰', note:'溫柔・細緻', accent:'#a9536a', background:'#f5e3e8'},
  ink: {name:'海岸藍灰', note:'沉穩・耐看', accent:'#496778', background:'#e3edf0'}
};
const DEFAULT_SETTINGS={name:'班級公告牆',subtitle:'班級消息・學習資源',header:'一起收藏班級的每一天',tagline:'把每一份提醒，放在剛剛好的位置。',icon:'✦'};
const starter = {
  settings:{...DEFAULT_SETTINGS},
  boards:[{id:'my-class',name:'我的班級公告',description:'歡迎來到我們的班級小角落。點選標題旁的「✎」，寫下你的班級名稱與介紹。',theme:'forest',
    sections:[{id:'calendar',name:'行事曆與重要公告'},{id:'notebook',name:'聯絡簿'},{id:'resources',name:'學習資源'}],posts:[]}],
  activeBoard:'my-class'
};


const $ = id => document.getElementById(id);
const e = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const clone = value => JSON.parse(JSON.stringify(value));
const uid = prefix => prefix + '-' + (window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
const isHex = value => /^#[0-9a-f]{6}$/i.test(value || '');
const isImage = value => typeof value === 'string' && (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value) || /^https:\/\//i.test(value));
function safeLink(value) { try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } }
function defaultAppearance(theme) { const t = themes[theme] || themes.forest; return { background:t.background, accent:t.accent, style:'soft', image:'', overlay:25 }; }
function normalizeState(data) {
  if (!data || !Array.isArray(data.boards) || !data.boards.length) throw new Error('備份中沒有看板。');
  const ids = new Set();
  const boards = data.boards.map(b => {
    if (!b || typeof b.name !== 'string' || !Array.isArray(b.sections) || !Array.isArray(b.posts)) throw new Error('備份格式不完整。');
    let id = typeof b.id === 'string' && b.id ? b.id : uid('board');
    if (ids.has(id)) throw new Error('看板編號重複。'); ids.add(id);
    const theme = themes[b.theme] ? b.theme : 'forest';
    const ap = {...defaultAppearance(theme), ...(b.appearance || {})};
    if (!isHex(ap.background)) ap.background = themes[theme].background;
    if (!isHex(ap.accent)) ap.accent = themes[theme].accent;
    if (!['soft','solid','dots','photo'].includes(ap.style)) ap.style = 'soft';
    ap.image = isImage(ap.image) ? ap.image : '';
    if (ap.style === 'photo' && !ap.image) ap.style = 'soft';
    ap.overlay = Math.min(85,Math.max(0,Number(ap.overlay) || 0));
    const sectionIds = new Set();
    const sections = b.sections.map(s => {
      if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || sectionIds.has(s.id)) throw new Error('分類資料格式錯誤。');
      sectionIds.add(s.id); return {...s};
    });
    if (!sections.length) sections.push({id:uid('section'),name:'未分類'});
    const postIds = new Set();
    const posts = b.posts.map((p,i) => {
      if (!p || typeof p.id !== 'string' || postIds.has(p.id) || typeof p.title !== 'string' || typeof p.body !== 'string') throw new Error('公告資料格式錯誤。');
      postIds.add(p.id);
      return {...p, section:sections.some(s=>s.id===p.section)?p.section:sections[0].id, link:safeLink(p.link), image:isImage(p.image)?p.image:'', color:['white','mint','peach','blue','rose'].includes(p.color)?p.color:'white', order:Number.isFinite(p.order)?p.order:i};
    });
    return {...b,id,theme,description:typeof b.description==='string'?b.description:'',appearance:ap,sections,posts};
  });
  const settings={...DEFAULT_SETTINGS};
  for(const key of Object.keys(settings))if(typeof data.settings?.[key]==='string')settings[key]=data.settings[key];
  return {...data,boards,settings,activeBoard:boards.some(b=>b.id===data.activeBoard)?data.activeBoard:boards[0].id};
}
let loadWarning = '';
function loadState() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { loadWarning='瀏覽器不允許儲存資料，請匯出備份保留修改。'; return normalizeState(clone(starter)); }
  try { return normalizeState(raw ? JSON.parse(raw) : clone(starter)); }
  catch { loadWarning='原資料讀取失敗；已保留原始資料，請先匯出原始備份。'; return normalizeState(clone(starter)); }
}
let state = loadState();
const GAS_MODE=!!window.google?.script?.run;
const adminKey=GAS_MODE&&location.hash.startsWith('#admin=')?decodeURIComponent(location.hash.slice(7)):'';
let canEdit=!GAS_MODE, cloudRevision='', cloudPublicUrl=location.href.split('#')[0], syncTimer=0, syncInFlight=false, syncQueued=false, cloudPollTimer=0;
let activeFilter='all', layout='columns', readMode=false, appearanceDraft=null, postImageDraft='', detailId='', deleteCallback=null, undoSnapshot=null, uploadToken=0, imageBusy=0;
function board() { return state.boards.find(b=>b.id===state.activeBoard) || state.boards[0]; }
function serverCall(name,...args){
  return new Promise((resolve,reject)=>google.script.run.withSuccessHandler(resolve).withFailureHandler(err=>reject(new Error(err?.message||String(err))))[name](...args));
}
function setCloudStatus(text,tone=''){
  const el=$('storageStatus');if(!el)return;el.textContent=text;el.dataset.tone=tone;
}
async function initializeCloud(){
  if(!GAS_MODE)return;
  document.body.classList.add('cloud-mode');setCloudStatus('雲端連線中…','working');
  try{
    const result=await serverCall('getCloudState',adminKey);
    state=normalizeState(result.state);canEdit=!!result.canEdit;cloudRevision=result.revision||'';cloudPublicUrl=result.publicUrl||cloudPublicUrl;
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    $('cloudRefreshBtn').hidden=false;
    render();setCloudStatus(canEdit?'雲端管理模式':'家長唯讀模式',canEdit?'ok':'readonly');
    clearInterval(cloudPollTimer);
    if(!canEdit)cloudPollTimer=setInterval(()=>{if(!document.hidden)refreshCloudState(false);},30000);
  }catch(err){
    canEdit=false;document.body.classList.add('viewer-mode');setCloudStatus('連線失敗','error');toast('雲端資料讀取失敗：'+err.message);
  }
}
async function refreshCloudState(showNotice=true){
  if(!GAS_MODE||syncInFlight)return;
  setCloudStatus('正在更新…','working');
  try{
    const result=await serverCall('getCloudState',adminKey);
    const changed=(result.revision||'')!==cloudRevision;
    canEdit=!!result.canEdit;cloudPublicUrl=result.publicUrl||cloudPublicUrl;
    if(changed){
      state=normalizeState(result.state);cloudRevision=result.revision||'';localStorage.setItem(STORAGE_KEY,JSON.stringify(state));render();
    }
    setCloudStatus(canEdit?'雲端管理模式':'家長唯讀模式',canEdit?'ok':'readonly');
    if(showNotice)toast(changed?'已載入最新公告。':'目前已是最新內容。');
  }catch(err){setCloudStatus('更新失敗','error');if(showNotice)toast('無法更新：'+err.message);}
}
function queueCloudSave(){
  if(!GAS_MODE||!canEdit)return;
  clearTimeout(syncTimer);setCloudStatus('正在同步…','working');
  syncTimer=setTimeout(syncCloudState,450);
}
async function syncCloudState(){
  if(syncInFlight){syncQueued=true;return;}
  syncInFlight=true;
  try{
    const result=await serverCall('saveCloudState',JSON.stringify(state),adminKey,cloudRevision);
    state=normalizeState(result.state);cloudRevision=result.revision||cloudRevision;localStorage.setItem(STORAGE_KEY,JSON.stringify(state));render();setCloudStatus('已同步雲端','ok');
  }catch(err){
    setCloudStatus('同步失敗','error');toast('雲端同步失敗，本機副本已保留：'+err.message);
  }finally{
    syncInFlight=false;if(syncQueued){syncQueued=false;syncCloudState();}
  }
}
function commit(mutator, message, reversible=false) {
  if(GAS_MODE&&!canEdit){toast('這是家長唯讀網址，無法修改公告。');return false;}
  if (loadWarning) { toast(loadWarning); return false; }
  const before = clone(state); const next = clone(state);
  try {
    mutator(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    state = next;
    if (reversible) undoSnapshot=before; else undoSnapshot=null;
    render();
    if ($('sectionsDialog').open) renderSections();
    toast(message, reversible);
    queueCloudSave();
    return true;
  } catch (err) {
    toast(err.name==='QuotaExceededError'?'儲存空間不足。這次修改未儲存，請匯出備份或移除不需要的圖片。':'無法儲存，這次修改未套用。請匯出備份並確認瀏覽器允許儲存。');
    return false;
  }
}
function toast(message, undo=false) {
  $('toastMessage').textContent=message; $('undoBtn').hidden=!undo; $('toast').classList.add('show');
  const openDialogs=Array.from(document.querySelectorAll('dialog[open]'));
  const content=openDialogs.at(-1)?.querySelector('.dialog-content');
  if(content){
    let feedback=content.querySelector('.dialog-feedback');
    if(!feedback){feedback=document.createElement('p');feedback.className='dialog-feedback';feedback.setAttribute('role','status');content.prepend(feedback);}
    feedback.textContent=message;
  }
  clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').classList.remove('show'),undo?18000:6500);
}
function today() { return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date()); }
function dateText(date) { return /^\d{4}-\d{2}-\d{2}$/.test(date||'')?date.replaceAll('-','/'):'日期未設定'; }
function showDialog(id) { $(id).querySelector('.dialog-feedback')?.remove(); $(id).showModal(); }
function closeDialog(dialog) { if(dialog?.open) dialog.close(); }
function appearanceCSS(ap,node) {
  node.style.setProperty('--board-bg',ap.background);
  node.style.setProperty('--accent',ap.accent);
  node.style.setProperty('--accent-soft',ap.accent+'15');
  const rgb=ap.accent.match(/\w\w/g).map(n=>parseInt(n,16));
  const lum=rgb.reduce((s,v,i)=>s+([.2126,.7152,.0722][i])*(v/255<=.04045?v/255/12.92:((v/255+.055)/1.055)**2.4),0);
  node.style.setProperty('--button-ink',lum>.35?'#172d26':'#ffffff');
  const bgRGB=ap.background.match(/\w\w/g).map(n=>parseInt(n,16));
  const bgLuma=bgRGB.reduce((s,v,i)=>s+([.2126,.7152,.0722][i])*(v/255<=.04045?v/255/12.92:((v/255+.055)/1.055)**2.4),0);
  node.style.setProperty('--wall-ink',bgLuma<.3?'#ffffff':'#263c34');
  node.style.setProperty('--wall-muted',bgLuma<.3?'#ffffffb5':'#43584ec9');
  node.dataset.background=ap.style;
  node.style.setProperty('--wallpaper',ap.style==='photo'&&ap.image?'url("'+ap.image+'")':'none');
  node.style.setProperty('--overlay',(ap.overlay/100).toString());
}
function render() {
  const b=board(); appearanceCSS(b.appearance,document.documentElement);
  $('boardTitle').textContent=b.name; $('boardDescription').textContent=b.description;
  $('postCount').textContent=b.sections.length+' 個分類 · '+b.posts.length+' 則公告';
  $('siteTitle').textContent=state.settings.name;
  $('siteSubtitle').textContent=state.settings.subtitle;
  $('siteHeaderLabel').textContent=state.settings.header;
  $('siteTagline').textContent=state.settings.tagline;
  $('siteIcon').textContent=state.settings.icon||'✦';
  document.title=b.name+'｜'+state.settings.name; document.body.classList.toggle('read-mode',readMode);document.body.classList.toggle('viewer-mode',GAS_MODE&&!canEdit);
  $('readModeBtn').textContent=readMode?'✎ 返回編輯':'◎ 閱讀模式'; $('readModeBtn').setAttribute('aria-pressed',readMode);
  renderBoards(); renderFilters(); renderColumns();
}
function renderBoards() {
  $('boardList').innerHTML=state.boards.map(b=>'<button class="board-item '+(b.id===board().id?'active':'')+'" data-board="'+e(b.id)+'"><span class="board-dot" style="background:'+b.appearance.accent+'"></span><span><strong>'+e(b.name)+'</strong><small>'+b.sections.length+' 個分類 · '+b.posts.length+' 則公告</small></span><span>›</span></button>').join('');
}
function renderFilters() {
  $('filterRow').innerHTML=[{id:'all',name:'全部'},...board().sections].map(s=>'<button class="filter-button '+(s.id===activeFilter?'active':'')+'" data-filter="'+e(s.id)+'" aria-pressed="'+(s.id===activeFilter)+'">'+e(s.name)+'</button>').join('');
}
function matchingPosts() {
  const b=board(), q=$('searchInput').value.trim().toLocaleLowerCase();
  return b.posts.filter(p=> (activeFilter==='all'||p.section===activeFilter) && (!q||(p.title+' '+p.body+' '+(b.sections.find(s=>s.id===p.section)?.name||'')).toLocaleLowerCase().includes(q))).sort((a,c)=>Number(c.pinned)-Number(a.pinned)||a.order-c.order);
}
function postCard(p) {
  const image=p.image || (/\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(p.link||'')?safeLink(p.link):'');
  return '<article class="post-card color-'+e(p.color)+' '+(p.pinned?'pinned':'')+'" data-post="'+e(p.id)+'" draggable="'+(!readMode&&canEdit)+'"><div class="card-content"><button class="card-title" data-detail="'+e(p.id)+'">'+e(p.title)+'</button>'+(image?'<button class="card-image-button" data-detail="'+e(p.id)+'" aria-label="查看 '+e(p.title)+' 圖片"><img src="'+e(image)+'" alt="'+e(p.title)+'" loading="lazy"></button>':'')+'<p>'+e(p.body)+'</p>'+(p.link?'<a class="attachment-link" href="'+e(p.link)+'" target="_blank" rel="noopener noreferrer">↗ 開啟附件或連結</a>':'')+'<div class="card-meta"><span>'+ (p.pinned?'📌 置頂提醒':'班級公告')+'</span><span>'+dateText(p.date)+'</span></div><div class="card-bottom"><button class="text-button" data-detail="'+e(p.id)+'">閱讀全文 <span>↗</span></button><div class="post-actions"><button class="card-icon" data-edit="'+e(p.id)+'" aria-label="編輯 '+e(p.title)+'">✎</button><button class="card-icon" data-pin="'+e(p.id)+'" aria-label="'+(p.pinned?'取消置頂':'置頂')+' '+e(p.title)+'">⌖</button><button class="card-icon" data-delete="'+e(p.id)+'" aria-label="移除 '+e(p.title)+'">×</button></div></div></div></article>';
}
function renderColumns() {
  const b=board(), posts=matchingPosts(), sections=activeFilter==='all'?b.sections:b.sections.filter(s=>s.id===activeFilter), q=$('searchInput').value.trim();
  $('searchSummary').hidden=!q; $('searchSummary').textContent='「'+q+'」找到 '+posts.length+' 則公告';
  $('columns').className='columns '+(layout==='grid'?'grid-layout':'');
  if(layout==='grid') $('columns').innerHTML=posts.length?posts.map(postCard).join(''):'<div class="empty-board">⌕<h3>目前沒有符合的公告</h3><p>可以切換分類、清除搜尋，或新增公告。</p></div>';
  else $('columns').innerHTML=sections.map((s,i)=> {
    const items=posts.filter(p=>p.section===s.id);
    return '<section class="column" data-section="'+e(s.id)+'"><div class="column-head"><div><span class="section-index">'+String(b.sections.findIndex(x=>x.id===s.id)+1).padStart(2,'0')+'</span><h2>'+e(s.name)+'</h2><span class="column-count">'+items.length+'</span></div><button class="column-manage icon-button" data-manage-section="'+e(s.id)+'" aria-label="管理 '+e(s.name)+' 分類">⋯</button></div><button class="new-column-button" data-new-section="'+e(s.id)+'" aria-label="在 '+e(s.name)+' 分類新增公告">＋ 新增公告</button><div class="column-posts">'+(items.length?items.map(postCard).join(''):'<div class="empty-column"><span>✧</span><p>'+ (q?'沒有符合的公告':'留一個位置，給新的消息。')+'</p></div>')+'</div></section>';
  }).join('')+(activeFilter==='all'?'<button class="add-column" id="inlineAddSectionBtn"><span>＋</span>新增分類</button>':'');
  requestAnimationFrame(sizeColumns);
}
function sizeColumns(){
  const el=$('columns');if(!el)return;
  const headers=Array.from(el.querySelectorAll('.column-head h2'));
  el.style.setProperty('--header-space',Math.max(44,...headers.map(n=>n.getBoundingClientRect().height+22))+'px');
  el.style.setProperty('--columns-height',Math.max(190,window.innerHeight-el.getBoundingClientRect().top-39)+'px');
}
window.addEventListener('resize',sizeColumns);
if(window.ResizeObserver){const observer=new ResizeObserver(()=>requestAnimationFrame(sizeColumns));document.querySelectorAll('.topbar,.board-hero,.board-controls').forEach(el=>observer.observe(el));}
function openPostDialog(id='',section='') {
  const b=board(), p=b.posts.find(x=>x.id===id); uploadToken++;
  $('postDialogTitle').textContent=p?'編輯公告':'新增公告'; $('postId').value=p?.id||''; $('postTitle').value=p?.title||'';
  $('postBody').value=p?.body||''; $('postLink').value=p?.link||''; $('postPinned').checked=!!p?.pinned; $('postColor').value=p?.color||'white';
  $('postSection').innerHTML=b.sections.map(s=>'<option value="'+e(s.id)+'">'+e(s.name)+'</option>').join('');
  $('postForm').dataset.boardId=b.id;
  $('postSection').value=p?.section||section||(activeFilter!=='all'?activeFilter:b.sections[0].id);
  postImageDraft=p?.image||'';
  $('postImageFile').value=''; $('postError').hidden=true; updatePostImage(); showDialog('postDialog');
}
function updatePostImage() { $('postImagePreview').hidden=!postImageDraft; if(postImageDraft) $('postImageThumb').src=postImageDraft; else $('postImageThumb').removeAttribute('src'); }
function openBoardDialog(edit=false) {
  closeDialog($('boardsDialog')); const b=board();
  $('boardDialogTitle').textContent=edit?'編輯看板':'新增看板'; $('boardId').value=edit?b.id:'';
  $('boardName').value=edit?b.name:''; $('boardDesc').value=edit?b.description:'';
  showDialog('boardDialog');
}
function openAppearance() {
  appearanceDraft=clone(board().appearance); appearanceDraft.theme=board().theme; uploadToken++;
  $('backgroundFile').value=''; renderThemes(); syncAppearanceInputs(); showDialog('themeDialog');
}
function renderThemes() {
  $('themeOptions').innerHTML=Object.entries(themes).map(([id,t])=>'<button type="button" class="theme-option '+(appearanceDraft.theme===id?'selected':'')+'" data-theme="'+id+'"><span class="theme-swatch" style="background:'+t.background+'"><i style="background:'+t.accent+'"></i></span><strong>'+t.name+'</strong><small>'+t.note+'</small></button>').join('');
}
function syncAppearanceInputs() {
  $('backgroundColor').value=$('backgroundHex').value=appearanceDraft.background; $('accentColor').value=$('accentHex').value=appearanceDraft.accent;
  $('backgroundStyle').value=appearanceDraft.style; $('overlayRange').value=appearanceDraft.overlay;
  updateAppearancePreview();
}
function updateAppearancePreview() {
  appearanceCSS(appearanceDraft,$('appearancePreview'));
  $('overlayValue').textContent=appearanceDraft.overlay+'%';
  $('backgroundFileStatus').textContent=appearanceDraft.image?'已載入底圖，套用後儲存':'尚未上傳底圖';
  $('removeBackgroundBtn').disabled=!appearanceDraft.image;
  $('overlayLabel').hidden=appearanceDraft.style!=='photo';
}
function openSections() { renderSections(); showDialog('sectionsDialog'); }
function renderSections() {
  const b=board();
  $('sectionList').innerHTML=b.sections.map((s,i)=>'<div class="section-row" data-section-row="'+e(s.id)+'"><span class="row-index">'+String(i+1).padStart(2,'0')+'</span><label class="sr-only" for="section-name-'+e(s.id)+'">分類名稱</label><input id="section-name-'+e(s.id)+'" value="'+e(s.name)+'" maxlength="80" data-section-name="'+e(s.id)+'"><span class="section-post-count">'+b.posts.filter(p=>p.section===s.id).length+' 則</span><div class="section-actions"><button class="icon-button" data-rename="'+e(s.id)+'" aria-label="儲存 '+e(s.name)+' 名稱">✓</button><button class="icon-button" data-up="'+e(s.id)+'" aria-label="上移 '+e(s.name)+'" '+(i===0?'disabled':'')+'>↑</button><button class="icon-button" data-down="'+e(s.id)+'" aria-label="下移 '+e(s.name)+'" '+(i===b.sections.length-1?'disabled':'')+'>↓</button><button class="icon-button delete-icon" data-remove-section="'+e(s.id)+'" aria-label="移除 '+e(s.name)+'">×</button></div></div>').join('');
}
function removeSectionDialog(id) {
  const b=board(), s=b.sections.find(s=>s.id===id);
  $('deleteSectionId').value=id; $('deleteSectionMessage').textContent='移除「'+s.name+'」分類，裡面的 '+b.posts.filter(p=>p.section===id).length+' 則公告要移到哪裡？';
  $('moveSectionTarget').innerHTML='<option value="__new__">建立「未分類」並移入</option>'+b.sections.filter(s=>s.id!==id).map(s=>'<option value="'+e(s.id)+'">'+e(s.name)+'</option>').join('');
  showDialog('deleteSectionDialog');
}
function showDetail(id) {
  const b=board(), p=b.posts.find(p=>p.id===id); if(!p)return; detailId=id;
  $('detailTitle').textContent=p.title; $('detailBody').textContent=p.body; $('detailMeta').textContent=(b.sections.find(s=>s.id===p.section)?.name||'公告')+' · '+dateText(p.date);
  const image=p.image||(/\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(p.link||'')?safeLink(p.link):'');
  $('detailImageBtn').hidden=!image; if(image) $('detailImage').src=image; else $('detailImage').removeAttribute('src');
  $('detailLink').hidden=!p.link; if(p.link)$('detailLink').href=p.link; else $('detailLink').removeAttribute('href');
  $('detailEditBtn').hidden=readMode; showDialog('detailDialog');
}
async function compressImage(file) {
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('請選擇 JPG、PNG 或 WebP 圖片。');
  if(file.size>15*1024*1024) throw new Error('圖片超過 15 MB，請先縮小圖片。');
  const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('讀取圖片失敗。'));r.readAsDataURL(file);});
  const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('圖片無法開啟，請換一張圖片。'));i.src=data;});
  if(!img.naturalWidth||!img.naturalHeight)throw new Error('圖片尺寸不正確。');
  const canvas=document.createElement('canvas'); let max=1600, result='';
  for(let pass=0;pass<5;pass++){
    const scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale)); canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    result=canvas.toDataURL('image/webp',.8-pass*.08);
    if(result.length<=600000)return result;
    max=Math.round(max*.75);
  }
  throw new Error('圖片縮小後仍太大，請選擇較簡單或較小的圖片。');
}
async function upload(input,kind) {
  const file=input.files[0]; if(!file)return; const token=uploadToken; imageBusy++; toggleUploadButtons();
  toast('正在縮小圖片，請稍候…');
  try{
    const image=await compressImage(file);
    if(token!==uploadToken || !$(kind==='background'?'themeDialog':'postDialog').open)return;
    if(kind==='background'){appearanceDraft.image=image;appearanceDraft.style='photo';appearanceDraft.overlay=25;syncAppearanceInputs();}
    else {postImageDraft=image;updatePostImage();}
    toast('圖片已載入，儲存後才會套用。');
  }catch(err){toast(err.message);}finally{imageBusy--;toggleUploadButtons();input.value='';}
}
function toggleUploadButtons() { $('saveThemeBtn').disabled=$('savePostBtn').disabled=imageBusy>0; }
function exportBackup() {
  let data=state;
  if(loadWarning){try{const raw=localStorage.getItem(STORAGE_KEY); if(raw) data=JSON.parse(raw);}catch{}}
  const blob=new Blob([JSON.stringify({format:'emily-wall',version:2,exportedAt:new Date().toISOString(),...data},null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);a.download='依依老師公告牆備份-'+today()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('備份已匯出，包含公告、分類與底圖。');
}

document.querySelectorAll('dialog').forEach(d=>{
  d.addEventListener('click',ev=>{if(ev.target===d){const r=d.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)closeDialog(d);}});
  d.addEventListener('close',()=>{if(['themeDialog','postDialog'].includes(d.id))uploadToken++;});
});
document.addEventListener('click',event=>{
  const el=event.target.closest('button,[data-close]');if(!el)return;
  if(el.hasAttribute('data-close'))return closeDialog(el.closest('dialog'));
  if(el.dataset.board){activeFilter='all';$('searchInput').value='';if(commit(s=>s.activeBoard=el.dataset.board,'已切換看板'))closeDialog($('boardsDialog'));return;}
  if(el.dataset.filter){activeFilter=el.dataset.filter;renderFilters();renderColumns();return;}
  if(el.dataset.newSection)return openPostDialog('',el.dataset.newSection);
  if(el.dataset.detail)return showDetail(el.dataset.detail);
  if(el.dataset.edit)return openPostDialog(el.dataset.edit);
  if(el.dataset.pin)return commit(s=>{const p=s.boards.find(b=>b.id===board().id).posts.find(p=>p.id===el.dataset.pin);p.pinned=!p.pinned;},'已更新置頂狀態');
  if(el.dataset.delete){
    const id=el.dataset.delete,p=board().posts.find(p=>p.id===id);$('confirmMessage').textContent='確定要移除「'+p.title+'」？';
    const bid=board().id;deleteCallback=()=>commit(s=>{s.boards.find(b=>b.id===bid).posts=s.boards.find(b=>b.id===bid).posts.filter(p=>p.id!==id);},'公告已移除',true);
    showDialog('confirmDialog');return;
  }
  if(el.dataset.manageSection||el.id==='inlineAddSectionBtn')return openSections();
  if(el.dataset.theme){
    const t=themes[el.dataset.theme];appearanceDraft.theme=el.dataset.theme;appearanceDraft.background=t.background;appearanceDraft.accent=t.accent;
    if(appearanceDraft.style!=='photo')appearanceDraft.style='soft';renderThemes();syncAppearanceInputs();return;
  }
  if(el.dataset.rename){
    const id=el.dataset.rename,node=Array.from(document.querySelectorAll('[data-section-name]')).find(n=>n.dataset.sectionName===id),name=node.value.trim();
    if(!name)return toast('分類名稱不可空白。');
    if(board().sections.some(s=>s.id!==id&&s.name===name))return toast('已有同名分類，請使用不同名稱。');
    commit(s=>s.boards.find(b=>b.id===board().id).sections.find(x=>x.id===id).name=name,'分類名稱已更新');return;
  }
  if(el.dataset.up||el.dataset.down){
    const id=el.dataset.up||el.dataset.down,delta=el.dataset.up?-1:1;
    commit(s=>{const list=s.boards.find(b=>b.id===board().id).sections,i=list.findIndex(x=>x.id===id),j=i+delta;if(j>=0&&j<list.length)[list[i],list[j]]=[list[j],list[i]];},'分類順序已更新');return;
  }
  if(el.dataset.removeSection)return removeSectionDialog(el.dataset.removeSection);
});
$('boardsBtn').onclick=()=>{renderBoards();showDialog('boardsDialog');};
$('themeBtn').onclick=openAppearance; $('sectionsBtn').onclick=openSections;
$('addPostBtn').onclick=()=>openPostDialog(); $('addBoardBtn').onclick=()=>openBoardDialog(); $('editBoardBtn').onclick=()=>openBoardDialog(true);
$('searchInput').oninput=renderColumns;
$('readModeBtn').onclick=()=>{readMode=!readMode;render();};
$('cloudRefreshBtn').onclick=()=>refreshCloudState(true);
$('shareBtn').onclick=()=>{
  $('publicShareUrl').value=GAS_MODE?cloudPublicUrl:location.href.split('#')[0];
  $('shareModeTitle').textContent=GAS_MODE?'雲端唯讀分享':'本機展示網址';
  $('shareModeNote').textContent=GAS_MODE?'家長可跨裝置讀取最新公告，無法修改內容。':'目前資料只存在這台裝置，分享網址不會同步公告。';
  $('shareDescription').textContent=GAS_MODE?'複製家長唯讀網址。管理密鑰不會包含在分享內容中。':'此版本尚未連接 GAS，網址只會顯示網站介面。';showDialog('shareDialog');
};
$('copyShareBtn').onclick=async()=>{try{await navigator.clipboard.writeText($('publicShareUrl').value);toast('唯讀網址已複製。');}catch{$('publicShareUrl').select();document.execCommand('copy');toast('唯讀網址已複製。');}};
$('filterToggleBtn').onclick=()=>{
  $('boardControls').hidden=!$('boardControls').hidden;
  $('filterToggleBtn').setAttribute('aria-expanded',!$('boardControls').hidden);
  requestAnimationFrame(sizeColumns);
};
function changeLayout(next){layout=next;['column','grid'].forEach(v=>{const el=$(v+'ViewBtn'),active=(v==='column'?'columns':'grid')===next;el.classList.toggle('active',active);el.setAttribute('aria-pressed',active);});renderColumns();}
$('columnViewBtn').onclick=()=>changeLayout('columns');$('gridViewBtn').onclick=()=>changeLayout('grid');
$('postForm').onsubmit=event=>{
  event.preventDefault();if(imageBusy)return;
  const title=$('postTitle').value.trim(),body=$('postBody').value.trim(),link=safeLink($('postLink').value.trim());
  if(!title){$('postTitle').focus();return;}
  if(!body&&!postImageDraft&&!link){$('postError').textContent='請加入公告內容、圖片或附件連結。';$('postError').hidden=false;return;}
  if($('postLink').value.trim()&&!link){$('postError').textContent='連結需以 https:// 或 http:// 開頭。';$('postError').hidden=false;return;}
  const id=$('postId').value,editorBoard=state.boards.find(b=>b.id===$('postForm').dataset.boardId),existing=editorBoard?.posts.find(p=>p.id===id);
  if(!editorBoard || !editorBoard.sections.some(s=>s.id===$('postSection').value))return toast('分類已變更，請重新開啟新增公告。');
  const payload={...(existing||{}),id:id||uid('post'),section:$('postSection').value,title,body,link,image:postImageDraft,color:$('postColor').value,pinned:$('postPinned').checked,date:existing?.date||today(),updatedAt:new Date().toISOString(),order:existing?.order??(Math.min(0,...board().posts.map(p=>p.order))-1)};
  const ok=commit(s=>{const posts=s.boards.find(b=>b.id===editorBoard.id).posts,i=posts.findIndex(p=>p.id===id);if(i>=0)posts[i]=payload;else posts.unshift(payload);},id?'公告已更新':'公告已儲存在本機');
  if(ok)closeDialog($('postDialog'));
};
$('boardForm').onsubmit=event=>{
  event.preventDefault();const name=$('boardName').value.trim();if(!name)return;const id=$('boardId').value,newId=uid('board');
  const ok=commit(s=>{if(id){const b=s.boards.find(b=>b.id===id);b.name=name;b.description=$('boardDesc').value.trim();}else{s.boards.push({id:newId,name,description:$('boardDesc').value.trim(),theme:'forest',appearance:defaultAppearance('forest'),sections:[{id:uid('section'),name:'重要公告'}],posts:[]});s.activeBoard=newId;}},id?'看板已更新':'看板已建立');
  if(ok){activeFilter='all';render();closeDialog($('boardDialog'));}
};
$('themeForm').onsubmit=event=>{
  event.preventDefault();if(imageBusy)return;
  if(appearanceDraft.style==='photo'&&!appearanceDraft.image)return toast('請先上傳底圖，或選擇其他背景樣式。');
  if(!isHex($('backgroundHex').value)||!isHex($('accentHex').value))return toast('請輸入完整色碼，例如 #E6EFE9。');
  const ap=clone(appearanceDraft);delete ap.theme;
  if(commit(s=>{const b=s.boards.find(b=>b.id===board().id);b.appearance=ap;b.theme=appearanceDraft.theme||b.theme;},'看板外觀已儲存'))closeDialog($('themeDialog'));
};
for(const [picker,hex,key] of [['backgroundColor','backgroundHex','background'],['accentColor','accentHex','accent']]){
  $(picker).oninput=()=>{appearanceDraft[key]=$(picker).value;$(hex).value=$(picker).value;appearanceDraft.theme='custom';renderThemes();updateAppearancePreview();};
  $(hex).oninput=()=>{if(isHex($(hex).value)){appearanceDraft[key]=$(hex).value;$(picker).value=$(hex).value;appearanceDraft.theme='custom';renderThemes();updateAppearancePreview();}};
}
$('backgroundStyle').onchange=()=>{appearanceDraft.style=$('backgroundStyle').value;updateAppearancePreview();};
$('overlayRange').oninput=()=>{appearanceDraft.overlay=Number($('overlayRange').value);updateAppearancePreview();};
$('backgroundFile').onchange=()=>upload($('backgroundFile'),'background');
$('postImageFile').onchange=()=>upload($('postImageFile'),'post');
$('removeBackgroundBtn').onclick=()=>{appearanceDraft.image='';appearanceDraft.style='soft';syncAppearanceInputs();};
$('removePostImageBtn').onclick=()=>{postImageDraft='';updatePostImage();};
$('addSectionForm').onsubmit=event=>{
  event.preventDefault();const name=$('newSectionName').value.trim();if(!name)return;
  if(board().sections.some(s=>s.name===name))return toast('已有同名分類。');
  if(commit(s=>s.boards.find(b=>b.id===board().id).sections.push({id:uid('section'),name}),'新分類已建立'))$('newSectionName').value='';
};
$('deleteSectionForm').onsubmit=event=>{
  event.preventDefault();const id=$('deleteSectionId').value,target=$('moveSectionTarget').value;
  const ok=commit(s=>{const b=s.boards.find(b=>b.id===board().id);let dest=target;
    if(target==='__new__'){let uncategorized=b.sections.find(s=>s.name==='未分類'&&s.id!==id);if(!uncategorized){uncategorized={id:uid('section'),name:'未分類'};b.sections.push(uncategorized);}dest=uncategorized.id;}
    b.posts.forEach(p=>{if(p.section===id)p.section=dest;});b.sections=b.sections.filter(s=>s.id!==id);
  },'分類已移除，公告完整保留',true);
  if(ok){activeFilter='all';render();closeDialog($('deleteSectionDialog'));}
};
$('detailEditBtn').onclick=()=>{closeDialog($('detailDialog'));openPostDialog(detailId);};
$('detailImageBtn').onclick=()=>{$('largeImage').src=$('detailImage').src;showDialog('imageDialog');};
$('confirmDeleteBtn').onclick=()=>{if(deleteCallback?.())closeDialog($('confirmDialog'));};
$('undoBtn').onclick=()=>{
  if(!undoSnapshot)return;try{localStorage.setItem(STORAGE_KEY,JSON.stringify(undoSnapshot));state=undoSnapshot;undoSnapshot=null;activeFilter='all';render();if($('sectionsDialog').open)renderSections();toast('已復原');queueCloudSave();}catch{toast('儲存空間不足，無法復原。');}
};
$('exportBtn').onclick=exportBackup;
$('siteSettingsBtn').onclick=()=>{
  for(const [id,key] of [['siteNameInput','name'],['siteSubtitleInput','subtitle'],['siteHeaderInput','header'],['siteTaglineInput','tagline'],['siteIconInput','icon']])$(id).value=state.settings[key];
  showDialog('siteSettingsDialog');
};
$('siteSettingsForm').onsubmit=event=>{
  event.preventDefault();if(!$('siteNameInput').value.trim())return;
  const settings={name:$('siteNameInput').value.trim(),subtitle:$('siteSubtitleInput').value.trim(),header:$('siteHeaderInput').value.trim(),tagline:$('siteTaglineInput').value.trim(),icon:$('siteIconInput').value.trim()||'✦'};
  if(commit(s=>s.settings=settings,'網站名稱設定已儲存'))closeDialog($('siteSettingsDialog'));
};
$('importFile').onchange=async()=>{
  const file=$('importFile').files[0];if(!file)return;
  try{
    if(file.size>20*1024*1024)throw new Error('備份超過 20 MB。');
    const incoming=normalizeState(JSON.parse(await file.text()));
    const ok=commit(s=>{
      const copies=incoming.boards.map(b=>({...b,id:uid('board'),name:b.name+'（匯入）'}));
      s.boards.push(...copies);s.activeBoard=copies[0].id;
    },'備份已新增為獨立看板，原有資料保留');
    if(ok){activeFilter='all';render();closeDialog($('boardsDialog'));}
  }catch(err){toast('匯入失敗：'+err.message);}
  $('importFile').value='';
};
let draggingId='';
$('columns').addEventListener('dragstart',event=>{
  const card=event.target.closest('[data-post]');
  if(!card||readMode)return;
  draggingId=card.dataset.post;event.dataTransfer.setData('text/plain',draggingId);event.dataTransfer.effectAllowed='move';card.classList.add('dragging');
});
$('columns').addEventListener('dragover',event=>{const col=event.target.closest('[data-section]');if(col&&draggingId&&!readMode){event.preventDefault();event.dataTransfer.dropEffect='move';col.classList.add('drag-over');}});
$('columns').addEventListener('dragleave',event=>{const col=event.target.closest('[data-section]');if(col&&!col.contains(event.relatedTarget))col.classList.remove('drag-over');});
$('columns').addEventListener('drop',event=>{
  const col=event.target.closest('[data-section]');if(!col||!draggingId||readMode)return;event.preventDefault();
  const id=draggingId,target=col.dataset.section,before=event.target.closest('[data-post]')?.dataset.post;
  draggingId='';
  commit(s=>{
    const b=s.boards.find(b=>b.id===board().id),p=b.posts.find(p=>p.id===id);if(!p)return;
    p.section=target;
    const list=b.posts.filter(x=>x.section===target&&x.id!==id).sort((a,c)=>a.order-c.order),index=list.findIndex(x=>x.id===before);
    list.splice(index>=0?index:list.length,0,p);list.forEach((x,i)=>x.order=i);
  },'公告位置已更新',true);
});
$('columns').addEventListener('dragend',()=>{draggingId='';document.querySelectorAll('.drag-over,.dragging').forEach(el=>el.classList.remove('drag-over','dragging'));});
$('columns').addEventListener('error',event=>{if(event.target instanceof HTMLImageElement)event.target.hidden=true;},true);
render();
if(loadWarning)toast(loadWarning);
if(GAS_MODE)initializeCloud();
document.addEventListener('visibilitychange',()=>{if(GAS_MODE&&!document.hidden&&!canEdit)refreshCloudState(false);});
