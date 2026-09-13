const STORAGE_KEY='livescope-state-v18';
const SAVED_KEY='livescope-layouts-v18';
const POLL_MS=30000;

const RETRY_MS=6000;
const MAX_CHAT=800;

const state={layout:2,streams:[],fit:'contain'};
const runtime=new Map();
const chat={items:[],paused:false,auto:true,sourceFilters:new Set(['__ALL__']),type:'chat',query:'',sourceColors:new Map(),nextColor:0,es:null};
const COLORS=['#ff4d67','#37a8ff','#4bdc7d','#b06cff','#ffb84d','#ff6ec7','#36d7c5','#9aa7ff'];
let pollTimer=null,toastTimer=null;

const grid=document.getElementById('grid'),template=document.getElementById('tileTemplate'),dialog=document.getElementById('addDialog'),form=document.getElementById('addForm'),input=document.getElementById('usernameInput'),errorBox=document.getElementById('dialogError'),liveCount=document.getElementById('liveCount'),fitBtn=document.getElementById('fitBtn'),refreshBtn=document.getElementById('refreshBtn'),loadBtn=document.getElementById('loadBtn'),layoutsDialog=document.getElementById('layoutsDialog'),savedList=document.getElementById('savedList'),nameDialog=document.getElementById('nameDialog'),nameForm=document.getElementById('nameForm'),nameInput=document.getElementById('layoutNameInput'),nameError=document.getElementById('nameError'),toast=document.getElementById('toast');
const chatPanel=document.getElementById('chatPanel'),chatFeed=document.getElementById('chatFeed'),chatSources=document.getElementById('chatSources'),chatSourceTrigger=document.getElementById('chatSourceTrigger'),chatSourceLabel=document.getElementById('chatSourceLabel'),chatSearch=document.getElementById('chatSearch'),chatType=document.getElementById('chatType'),chatStatus=document.getElementById('chatStatus'),chatSourcePicker=document.getElementById('chatSourcePicker');

function notify(message){toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2200)}
function saveState(){localStorage.setItem(STORAGE_KEY,JSON.stringify({layout:state.layout,fit:state.fit,streams:state.streams.map(({id,username,order,live,status,viewerCount,title,roomId,streamUrl})=>({id,username,order,live,status,viewerCount,title,roomId,streamUrl}))}))}
function loadState(){try{const x=JSON.parse(localStorage.getItem(STORAGE_KEY));if(x?.streams)state.streams=x.streams;if([2,3,4].includes(x?.layout))state.layout=x.layout;if(['contain','cover'].includes(x?.fit))state.fit=x.fit}catch{}}
function savedLayouts(){try{const x=JSON.parse(localStorage.getItem(SAVED_KEY));return Array.isArray(x)?x:[]}catch{return []}}
function writeSavedLayouts(items){localStorage.setItem(SAVED_KEY,JSON.stringify(items))}
function normalized(v){let s=String(v||'').trim().replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('?')[0].split('#')[0];if(s.includes('tiktok.com/@'))s=s.split('tiktok.com/@')[1];s=s.replace(/^@/,'').split('/')[0];return /^[A-Za-z0-9._-]{1,50}$/.test(s)?s:null}
function updateCount(){const n=state.streams.filter(x=>x.live&&x.streamUrl).length;liveCount.innerHTML=`<i></i> ${n} LIVE`}
function stopRuntime(id){const r=runtime.get(id);if(!r)return;try{r.hls?.destroy()}catch{}if(r.retryTimer)clearTimeout(r.retryTimer);runtime.delete(id)}
function teardownAll(){for(const id of [...runtime.keys()])stopRuntime(id)}
function setFitMode(){grid.classList.toggle('fit-cover',state.fit==='cover');fitBtn.textContent=state.fit==='contain'?'Fit: Full':'Fit: Crop';fitBtn.classList.toggle('active',state.fit==='contain');document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('cover',state.fit==='cover'))}
function tileById(id){return document.querySelector(`[data-stream-id="${CSS.escape(id)}"]`)}
function streamColor(username){const key=String(username||'').toLowerCase();if(!chat.sourceColors.has(key)){chat.sourceColors.set(key,COLORS[chat.nextColor%COLORS.length]);chat.nextColor++}return chat.sourceColors.get(key)}
function updateChatSourceLabel(){
  const selected=[...chat.sourceFilters].filter(x=>x!=='__ALL__');
  if(chat.sourceFilters.has('__ALL__')||!selected.length){chatSourceLabel.textContent='All streams';return}
  if(selected.length===1){chatSourceLabel.textContent=`@${selected[0]}`;return}
  chatSourceLabel.textContent=`${selected.length} streams`;
}
function buildSources(){
  const selected=chat.sourceFilters;
  chatSources.innerHTML='';
  const addOption=(key,label,color,checked,all=false)=>{
    const b=document.createElement('button');
    b.type='button';
    b.className=`source-option${checked?' selected':''}`;
    b.setAttribute('role','option');
    b.setAttribute('aria-selected',String(checked));
    b.innerHTML=`<span class="source-check">${checked?'✓':''}</span><span class="source-color" style="--source-color:${color||'#82909b'}"></span><span class="source-label">${escapeHtml(label)}</span>`;
    b.onclick=e=>{
      e.preventDefault();
      if(all){chat.sourceFilters=new Set(['__ALL__']);}
      else{
        const next=new Set(chat.sourceFilters);
        next.delete('__ALL__');
        if(next.has(key))next.delete(key);else next.add(key);
        if(!next.size)next.add('__ALL__');
        chat.sourceFilters=next;
      }
      buildSources();
      updateChatSourceLabel();
      renderChat();
    };
    chatSources.appendChild(b);
  };
  addOption('__ALL__','All streams','#82909b',selected.has('__ALL__'),true);
  if(state.streams.length){
    const sep=document.createElement('div');sep.className='source-menu-sep';chatSources.appendChild(sep);
    state.streams.forEach(s=>{const key=s.username.toLowerCase();addOption(key,`@${s.username}`,streamColor(s.username),selected.has(key));});
  }
  updateChatSourceLabel();
}
function chatPass(item){if(chat.type!=='all'&&item.type!==chat.type)return false;const q=chat.query.toLowerCase();if(q&&!`${item.user} ${item.nickname} ${item.comment}`.toLowerCase().includes(q))return false;if(!chat.sourceFilters.has('__ALL__')&&!chat.sourceFilters.has(item.source.toLowerCase()))return false;return true}
function renderChat(forceBottom=false){const items=chat.items.filter(chatPass).slice(-MAX_CHAT);if(!items.length){chatFeed.innerHTML='<div class="chat-empty">No matching messages.</div>';return}chatFeed.innerHTML=items.map((item,index)=>{const c=streamColor(item.source);const text=escapeHtml(String(item.comment||''));const user=escapeHtml(String(item.user||'viewer'));const source=escapeHtml(String(item.source||''));const kind=escapeHtml(String(item.type||'chat'));return `<div class="chat-item" data-chat-index="${index}" data-source="${source}" style="--chat-color:${c}"><span class="chat-dot" style="background:${c}"></span><div class="chat-line"><div class="chat-top"><span class="chat-source" style="color:${c}">@${source}</span><span class="chat-user">${user}</span><span class="chat-kind">${kind}</span></div><div class="chat-text">${text}</div></div></div>`}).join('');chatFeed.querySelectorAll('.chat-item').forEach(el=>el.onclick=()=>highlightSource(el.dataset.source));if(chat.auto||forceBottom)chatFeed.scrollTop=chatFeed.scrollHeight}
function highlightSource(username){const s=state.streams.find(x=>x.username.toLowerCase()===String(username).toLowerCase());if(!s)return;const t=tileById(s.id);if(!t)return;t.classList.add('chat-highlight');t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>t.classList.remove('chat-highlight'),1200)}
function pushChat(item){if(!item?.source)return;if(item.type==='chat'&&!String(item.comment||'').trim())return;chat.items.push(item);if(chat.items.length>MAX_CHAT)chat.items.splice(0,chat.items.length-MAX_CHAT);if(!chat.paused)renderChat(chat.auto);chatStatus.textContent='Live chat connected'}
function connectChatEvents(){if(chat.es)return;chat.es=new EventSource('/api/chat/events');chat.es.onopen=()=>chatStatus.textContent='Live chat connected';chat.es.onmessage=e=>{try{pushChat(JSON.parse(e.data))}catch{}};chat.es.onerror=()=>{chatStatus.textContent='Chat reconnecting…'}}
async function connectChat(stream){try{const r=await fetch('/api/chat/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:stream.username,roomId:stream.roomId})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Chat connection failed');pushChat({type:'system',source:stream.username,comment:'chat connected',timestamp:Date.now()})}catch(e){pushChat({type:'system',source:stream.username,comment:`chat unavailable: ${e.message}`,timestamp:Date.now()})}}
async function disconnectChat(username){try{await fetch('/api/chat/disconnect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username})})}catch{}}

function render(){updateChatSourceLabel();const oldIds=new Set(state.streams.map(s=>s.id));for(const id of runtime.keys())if(!oldIds.has(id))stopRuntime(id);grid.className=`grid grid-${state.layout}`;grid.innerHTML='';setFitMode();buildSources();if(!state.streams.length){grid.innerHTML='<div class="empty"><div><div class="eyebrow">NO MONITORS</div><h2>Add your first TikTok LIVE</h2><p>Use “＋ Add LIVE” to create a monitor.</p></div></div>';updateCount();return}state.streams.forEach((stream,index)=>{stream.order=index;const node=template.content.cloneNode(true),tile=node.querySelector('.tile'),video=node.querySelector('.video'),placeholder=node.querySelector('.placeholder'),screen=node.querySelector('.screen'),name=node.querySelector('.name'),dot=node.querySelector('.dot'),status=node.querySelector('.status-text'),viewers=node.querySelector('.viewer-text'),meta=node.querySelector('.stream-meta');tile.dataset.streamId=stream.id;name.textContent=`@${stream.username}`;status.textContent=stream.status||'READY';status.title=stream.error||'';viewers.textContent=`${Number(stream.viewerCount||0).toLocaleString()} viewers`;meta.textContent=stream.live?'Auto reconnect + chat':'Automatic LIVE check on';if(stream.live){dot.style.background='#17d36a';dot.style.boxShadow='0 0 10px rgba(23,211,106,.7)';streamColor(stream.username)}if(state.fit==='cover')screen.classList.add('cover');tile.addEventListener('dragstart',e=>{tile.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',stream.id)});tile.addEventListener('dragend',()=>tile.classList.remove('dragging'));tile.addEventListener('dragover',e=>{e.preventDefault();tile.classList.add('drag-over');e.dataTransfer.dropEffect='move'});tile.addEventListener('dragleave',()=>tile.classList.remove('drag-over'));tile.addEventListener('drop',e=>{e.preventDefault();tile.classList.remove('drag-over');const sourceId=e.dataTransfer.getData('text/plain');if(!sourceId||sourceId===stream.id)return;const from=state.streams.findIndex(s=>s.id===sourceId),to=state.streams.findIndex(s=>s.id===stream.id);if(from<0||to<0)return;const [moved]=state.streams.splice(from,1);state.streams.splice(to,0,moved);saveState();render()});node.querySelector('.remove-btn').onclick=()=>{stopRuntime(stream.id);disconnectChat(stream.username);state.streams=state.streams.filter(s=>s.id!==stream.id);saveState();render();renderChat()};node.querySelector('.focus-btn').onclick=()=>focusAudio(stream.id);node.querySelector('.fullscreen-btn').onclick=()=>{const target=screen;(target.requestFullscreen||target.webkitRequestFullscreen)?.call(target)?.catch?.(()=>{})};node.querySelector('.center-retry').onclick=()=>refreshStream(stream.id);grid.appendChild(node);if(stream.streamUrl)attachHls(video,placeholder,stream.streamUrl,stream.id);else if(stream.status==='OFFLINE'){setPlaceholder(placeholder,'offline','OFFLINE','This TikTok LIVE is not currently available',{retry:true,animate:false})}else if(stream.status==='LIVE / NO PLAYBACK URL'){setPlaceholder(placeholder,'offline','OFFLINE','No current LIVE playback stream is available',{retry:true,animate:false})}else if(stream.status==='ERROR'){setPlaceholder(placeholder,'error','UNABLE TO DISPLAY LIVE','Tap refresh to try this monitor again',{retry:true,animate:true})}else{setPlaceholder(placeholder,'connecting','CONNECTING TO STREAM...','Checking TikTok LIVE playback',{retry:false,animate:true})}});updateCount()}
function focusAudio(id){document.querySelectorAll('video').forEach(v=>{v.muted=true});document.querySelectorAll('.focus-btn').forEach(btn=>btn.classList.remove('active'));const r=runtime.get(id),video=r?.video;if(video){video.muted=false;video.controls=true;video.play().catch(()=>{});r.tile?.querySelector('.focus-btn')?.classList.add('active')}}
function placeholderParts(placeholder){return {big:placeholder?.querySelector('.big'),sub:placeholder?.querySelector('.sub'),retry:placeholder?.querySelector('.center-retry'),beat:placeholder?.querySelector('.tt-beat')}}
function setPlaceholder(placeholder,state,big,sub,{retry=true,animate=true}={}){if(!placeholder)return;const parts=placeholderParts(placeholder);placeholder.dataset.state=state;placeholder.style.display='grid';if(parts.big)parts.big.textContent=big;if(parts.sub)parts.sub.textContent=sub;if(parts.retry)parts.retry.hidden=!retry;if(parts.beat)parts.beat.style.display=animate?'grid':'none'}
function refreshStream(streamId){const stream=state.streams.find(s=>s.id===streamId);if(!stream)return;const tile=tileById(streamId);const placeholder=tile?.querySelector('.placeholder');if(placeholder)setPlaceholder(placeholder,'connecting','CONNECTING TO STREAM...','Refreshing LIVE playback',{retry:false,animate:true}); resolve(stream,{silent:true,reconnect:true}).catch(()=>{});}

function scheduleReconnect(streamId){const r=runtime.get(streamId);if(!r||r.retryTimer)return;r.retryTimer=setTimeout(async()=>{r.retryTimer=null;stopRuntime(streamId);const s=state.streams.find(x=>x.id===streamId);if(!s)return;await resolve(s,{silent:true,reconnect:true});if(s.streamUrl){const tile=tileById(s.id);const video=tile?.querySelector('.video');const placeholder=tile?.querySelector('.placeholder');if(tile&&video&&placeholder)attachHls(video,placeholder,s.streamUrl,s.id)}},RETRY_MS)}
function attachHls(video,placeholder,url,id){const current=runtime.get(id);if(current?.url===url&&current.video===video)return;stopRuntime(id);runtime.set(id,{video,url,tile:video.closest('.tile'),hls:null,retryTimer:null});setPlaceholder(placeholder,'connecting','CONNECTING TO STREAM...','Loading LIVE playback',{retry:true,animate:true});const retryBtn=placeholder?.querySelector('.center-retry');if(retryBtn)retryBtn.onclick=()=>refreshStream(id);if(!window.Hls&&!video.canPlayType('application/vnd.apple.mpegurl')){setPlaceholder(placeholder,'error','PLAYBACK NOT SUPPORTED','This browser cannot play the LIVE stream',{retry:true,animate:false});return}const markReady=()=>{placeholder.style.display='none';video.classList.add('ready');video.play().catch(()=>{})};if(window.Hls?.isSupported()){const hls=new Hls({lowLatencyMode:true,liveDurationInfinity:true,backBufferLength:20,maxBufferLength:15,enableWorker:true});runtime.get(id).hls=hls;hls.loadSource(url);hls.attachMedia(video);hls.on(Hls.Events.MANIFEST_PARSED,markReady);hls.on(Hls.Events.ERROR,(_e,d)=>{if(d?.fatal){try{hls.destroy()}catch{}const rr=runtime.get(id);if(rr)rr.hls=null;setPlaceholder(placeholder,'error','STREAM NOT DISPLAYING','The LIVE was detected, but playback did not start — tap refresh',{retry:true,animate:true});scheduleReconnect(id)}})}else{video.src=url;video.addEventListener('loadedmetadata',markReady,{once:true});video.addEventListener('error',()=>{setPlaceholder(placeholder,'error','STREAM NOT DISPLAYING','The LIVE was detected, but playback did not start — tap refresh',{retry:true,animate:true});scheduleReconnect(id)},{once:true})}}

function syncTile(stream){const tile=tileById(stream.id);if(!tile)return false;const status=tile.querySelector('.status-text'),viewers=tile.querySelector('.viewer-text'),dot=tile.querySelector('.dot'),meta=tile.querySelector('.stream-meta');if(status){status.textContent=stream.status||'READY';status.title=stream.error||''}if(viewers)viewers.textContent=`${Number(stream.viewerCount||0).toLocaleString()} viewers`;if(meta)meta.textContent=stream.live?'Auto reconnect + chat':'Automatic LIVE check on';if(dot){dot.style.background=stream.live?'#17d36a':'#6b747c';dot.style.boxShadow=stream.live?'0 0 10px rgba(23,211,106,.7)':'none'}return true}
async function resolve(stream,{silent=false,reconnect=false}={}){
  const previousUrl=stream.streamUrl;
  const previousLive=Boolean(stream.live);
  const previousStatus=stream.status;
  if(!silent){stream.status='CHECKING';stream.error='';syncTile(stream);}
  try{
    const r=await fetch('/api/live/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:stream.username})});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'Unable to resolve LIVE');

    Object.assign(stream,data,{status:data.streamUrl?'LIVE':data.live?'LIVE / NO PLAYBACK URL':'OFFLINE'});
    const urlChanged=previousUrl!==stream.streamUrl;
    const liveChanged=previousLive!==Boolean(stream.live);
    const statusChanged=previousStatus!==stream.status;

    // Never rebuild the whole grid during background polling or reconnects.
    // Update only this tile and only replace the media pipeline when its URL changes.
    syncTile(stream);
    const tile=tileById(stream.id);
    const video=tile?.querySelector('.video');
    const placeholder=tile?.querySelector('.placeholder');

    if(stream.streamUrl){
      if(urlChanged || reconnect || !runtime.has(stream.id)){
        if(tile&&video&&placeholder)attachHls(video,placeholder,stream.streamUrl,stream.id);
      }else if(video?.paused){
        video.play().catch(()=>{});
      }
    }else{
      stopRuntime(stream.id);
      if(placeholder){
        setPlaceholder(placeholder,'offline','OFFLINE','No current LIVE playback stream is available',{retry:true,animate:false});
        placeholder.querySelector('.center-retry')?.addEventListener('click',()=>refreshStream(stream.id),{once:true});
      }
      if(video){video.classList.remove('ready');video.removeAttribute('src');video.load?.();}
    }

    // Chat lifecycle is also scoped to this stream only.
    if(stream.live&&stream.roomId)connectChat(stream);
    else if(!stream.live)disconnectChat(stream.username);

    saveState();
    if(reconnect)notify(`Reconnected @${stream.username}`);
    else if(!silent)notify(`${stream.live?'LIVE detected':'Checked'} @${stream.username}`);

    // Keep these values referenced so the intent is explicit without triggering a global render.
    void liveChanged; void statusChanged;
  }catch(e){
    stream.status='ERROR';
    stream.error=e.message;
    syncTile(stream);
    const tile=tileById(stream.id); const placeholder=tile?.querySelector('.placeholder');
    if(placeholder) setPlaceholder(placeholder,'error','UNABLE TO DISPLAY LIVE','Tap refresh to try this monitor again',{retry:true,animate:true});
    saveState();
    if(!silent)notify(`Resolver error @${stream.username}`);
    pushChat({type:'system',source:stream.username,comment:`stream resolver error: ${e.message}`,timestamp:Date.now()});
  }
}
async function refreshAll(){
  if(!state.streams.length)return;
  // Refresh each monitor independently. No window reload and no full-grid render.
  await Promise.all(state.streams.map(s=>resolve(s,{silent:true})));
}
function startPolling(){
  clearInterval(pollTimer);
  pollTimer=setInterval(()=>refreshAll().catch(()=>{}),POLL_MS);
}
function shareRoom(){const payload={layout:state.layout,fit:state.fit,streams:state.streams.map(s=>s.username)};const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');const url=`${location.origin}/monitor#room=${encoded}`;navigator.clipboard?.writeText(url).then(()=>notify('LiveScope room link copied')).catch(()=>prompt('Copy this room link:',url))}
function loadRoomFromHash(){const hash=location.hash.match(/^#room=([A-Za-z0-9_-]+)$/);if(!hash)return false;try{const raw=hash[1],padded=raw.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-(raw.length%4))%4),data=JSON.parse(decodeURIComponent(escape(atob(padded))));if([2,3,4].includes(data.layout))state.layout=data.layout;if(['contain','cover'].includes(data.fit))state.fit=data.fit;if(Array.isArray(data.streams))state.streams=data.streams.map((username,i)=>({id:crypto.randomUUID(),username:String(username),order:i,live:false,status:'CHECKING',viewerCount:0,title:'',roomId:'',streamUrl:''}));localStorage.removeItem(STORAGE_KEY);return true}catch{return false}}
function openSavedLayouts(){const items=savedLayouts();if(!items.length)savedList.innerHTML='<div class="empty" style="min-height:160px"><div><div class="eyebrow">NO SAVED LAYOUTS</div><p>Use Save to store this setup.</p></div></div>';else savedList.innerHTML=items.map((item,index)=>`<div class="saved-item"><div class="meta"><strong>${escapeHtml(item.name)}</strong><span>${item.streams.length} monitor${item.streams.length===1?'':'s'} · ${item.layout}×${item.layout}</span></div><div class="saved-actions"><button data-load="${index}">Load</button><button data-delete="${index}">Delete</button></div></div>`).join('');savedList.querySelectorAll('[data-load]').forEach(btn=>btn.onclick=()=>{const item=items[Number(btn.dataset.load)];if(!item)return;teardownAll();state.layout=item.layout;state.fit=item.fit||'contain';state.streams=item.streams.map((username,i)=>({id:crypto.randomUUID(),username,order:i,live:false,status:'CHECKING',viewerCount:0,title:'',roomId:'',streamUrl:''}));saveState();layoutsDialog.close();render();state.streams.forEach(s=>resolve(s,{silent:true}));notify(`Loaded ${item.name}`)});savedList.querySelectorAll('[data-delete]').forEach(btn=>btn.onclick=()=>{const next=items.filter((_,i)=>i!==Number(btn.dataset.delete));writeSavedLayouts(next);openSavedLayouts()});layoutsDialog.showModal()}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]))}
function exitRoom(){
  teardownAll();
  state.streams=[];
  runtime.clear();
  chat.items=[];
  chat.es?.close();
  try{localStorage.removeItem(STORAGE_KEY)}catch{}
  try{location.hash=''}catch{}
  notify('Room closed');
  setTimeout(()=>location.assign('/'),80);
}

function checkTool(){return fetch('/api/tools').then(r=>r.json()).catch(()=>null)}

document.getElementById('exitRoomBtn').onclick=exitRoom;document.getElementById('addBtn').onclick=()=>{errorBox.hidden=true;input.value='';dialog.showModal();input.focus()};document.getElementById('saveBtn').onclick=()=>{nameError.hidden=true;nameInput.value='';nameDialog.showModal();nameInput.focus()};document.getElementById('shareBtn').onclick=shareRoom;document.getElementById('chatToggle').onclick=()=>{chatPanel.classList.toggle('hidden');document.querySelector('.app-shell').classList.toggle('chat-hidden',chatPanel.classList.contains('hidden'))};document.getElementById('chatClose').onclick=()=>{chatPanel.classList.add('hidden');document.querySelector('.app-shell').classList.add('chat-hidden')};refreshBtn.onclick=()=>refreshAll().catch(()=>{});loadBtn.onclick=openSavedLayouts;fitBtn.onclick=()=>{state.fit=state.fit==='contain'?'cover':'contain';saveState();setFitMode();notify(state.fit==='contain'?'Full frame fit enabled':'Crop mode enabled')};document.querySelectorAll('[data-layout]').forEach(b=>b.onclick=()=>{state.layout=Number(b.dataset.layout);saveState();render()});
chatSourceTrigger.onclick=()=>{const open=chatSources.hidden;chatSources.hidden=!open;chatSourceTrigger.setAttribute('aria-expanded',String(open));chatSourcePicker.classList.toggle('open',open)};
chatSearch.oninput=()=>{chat.query=chatSearch.value;renderChat()};chatType.onchange=()=>{chat.type=chatType.value;renderChat()};document.getElementById('chatPause').onclick=()=>{chat.paused=!chat.paused;document.getElementById('chatPause').textContent=chat.paused?'Resume':'Pause'};document.getElementById('chatClear').onclick=()=>{chat.items=[];renderChat()};document.getElementById('chatAuto').onclick=()=>{chat.auto=!chat.auto;document.getElementById('chatAuto').classList.toggle('active',chat.auto);if(chat.auto)chatFeed.scrollTop=chatFeed.scrollHeight};
form.addEventListener('submit',e=>{e.preventDefault();const username=normalized(input.value);if(!username){errorBox.textContent='Enter a valid TikTok username or profile URL.';errorBox.hidden=false;return}if(state.streams.some(s=>s.username.toLowerCase()===username.toLowerCase())){dialog.close();notify('That LIVE is already in the grid');return}const stream={id:crypto.randomUUID(),username,order:state.streams.length,live:false,status:'CHECKING',viewerCount:0,title:'',roomId:'',streamUrl:''};state.streams.push(stream);saveState();render();dialog.close();resolve(stream)});
nameForm.addEventListener('submit',e=>{e.preventDefault();const name=nameInput.value.trim();if(!name){nameError.textContent='Enter a layout name.';nameError.hidden=false;return}const items=savedLayouts();items.unshift({name,layout:state.layout,fit:state.fit,streams:state.streams.map(s=>s.username),createdAt:Date.now()});writeSavedLayouts(items.slice(0,20));nameDialog.close();notify(`Saved ${name}`)});
document.addEventListener('click',e=>{if(!chatSourcePicker.contains(e.target)){chatSources.hidden=true;chatSourcePicker.classList.remove('open');chatSourceTrigger.setAttribute('aria-expanded','false')}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){chatSources.hidden=true;chatSourcePicker.classList.remove('open');chatSourceTrigger.setAttribute('aria-expanded','false')}});
window.addEventListener('beforeunload',()=>{teardownAll();state.streams.forEach(s=>disconnectChat(s.username));chat.es?.close()});

loadState();
const quickAdd = new URLSearchParams(location.search).get('add');
if (quickAdd) {
  const n = normalized(quickAdd);
  if (n && !state.streams.some(s=>s.username.toLowerCase()===n.toLowerCase())) {
    state.streams.push({id:crypto.randomUUID(),username:n,order:state.streams.length,live:false,status:'CHECKING',viewerCount:0,title:'',roomId:'',streamUrl:''});
    saveState();
  }
  history.replaceState({},'', '/monitor');
}
const roomLoaded=loadRoomFromHash();
render();renderChat();connectChatEvents();checkTool();startPolling();if(state.streams.length)setTimeout(()=>refreshAll().catch(()=>{}),250);if(roomLoaded)notify('Shared LiveScope room loaded');
