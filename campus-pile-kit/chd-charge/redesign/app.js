(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const MY_IDS = ['4GR00008492','4GR00008485','4GR00008489','4GR00008490','4GR00006723'];
  let saved={};try{saved=JSON.parse(localStorage.getItem('stu-charge-web-preferences')||'{}')||{};}catch{}
  if(typeof saved!=='object'||Array.isArray(saved))saved={};
  const state={data:null,receivedAt:0,page:'map',filter:'all',query:'',sort:'id',selectedLocation:saved.selectedLocation||'teachers',favorites:new Set(Array.isArray(saved.favorites)?saved.favorites:MY_IDS),names:saved.names&&typeof saved.names==='object'&&!Array.isArray(saved.names)?saved.names:{},auto:saved.auto!==false,busy:false,dialogId:null,port:null};
  const camera={x:0,y:0,w:1630,h:1536};
  let mapReady=false,toastTimer,pollTimer,lastWidth=0,autoTimer;
  let pendingNativeDevice=null;
  const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const all = () => state.data?.devices||[];
  const named = s => s.display_name;
  const locations = () => state.data?.locations||[];
  const selectedSite = () => locations().find(l=>l.id===state.selectedLocation)||locations()[0];
  const locationOf = s => locations().find(l=>l.id===s.location_id);
  const atSite = site => (site?.device_ids||[]).map(id=>all().find(s=>s.id===id)).filter(Boolean);
  const remark = s => typeof state.names[s.id]==='string'?state.names[s.id].trim().slice(0,24):'';
  const fresh = s => s.source==='platform'&&!s.error&&typeof s.age_seconds==='number'&&s.age_seconds+(Date.now()-state.receivedAt)/1000>=0&&s.age_seconds+(Date.now()-state.receivedAt)/1000<=120;
  const valid = devices => devices.filter(fresh);
  const free = devices => valid(devices).reduce((n,s)=>n+s.counts.free,0);
  function availability(devices){
    const live=valid(devices),known=live.reduce((n,s)=>n+s.counts.free,0),capacity=devices.reduce((n,s)=>n+s.expected_ports,0);
    const complete=devices.length>0&&live.length===devices.length&&capacity>0;
    const key=!complete?'unknown':known===0?'full':known*4<=capacity?'low':'available';
    const label=complete?({full:'暂无空位',low:'空位较少',available:'空位充足'})[key]:live.length?'部分已更新':'待更新';
    return {key,label,known,capacity,complete};
  }
  const siteDevices = () => atSite(selectedSite());
  function save(){try{localStorage.setItem('stu-charge-web-preferences',JSON.stringify({favorites:[...state.favorites],names:state.names,selectedLocation:state.selectedLocation,auto:state.auto}));}catch{}}
  function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
  const dt = (value,full=false) => {if(!value)return '尚未查询';try{return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(full?{month:'2-digit',day:'2-digit'}:{}),hour:'2-digit',minute:'2-digit',...(full?{}:{second:'2-digit'}),hour12:false}).format(new Date(value));}catch{return '时间未知';}};
  function sourceLabel(s){if(fresh(s))return '实时 · '+dt(s.last_success);if(s.source==='unqueried')return '尚未获取状态';if(s.source==='repository_snapshot')return '历史快照 · '+dt(s.snapshot_at,true);return '旧记录 · '+dt(s.last_success,true);}
  function storeData(data){
    const locationsChanged=JSON.stringify(state.data?.locations)!==JSON.stringify(data.locations);
    state.data=data;state.receivedAt=Date.now();
    const ids=new Set(data.devices.map(s=>s.id));
    state.favorites=new Set([...state.favorites].filter(id=>ids.has(id)));
    for(const id of Object.keys(state.names))if(!ids.has(id))delete state.names[id];
    if(!data.locations.some(l=>l.id===state.selectedLocation))state.selectedLocation=({mingde:'siyuan',wennan:'siyuan',hongyi:'xiuyuan',sports:'skating'})[state.selectedLocation]||data.locations.find(l=>l.id==='teachers')?.id||data.locations[0]?.id;
    save();try{for(const key of ['stu-charge-web-last-data','stu-charge-web-last-data-v2','stu-charge-web-last-data-v3','stu-charge-web-last-data-v4','stu-charge-web-last-data-v5'])localStorage.removeItem(key);localStorage.setItem('stu-charge-web-last-data-v6',JSON.stringify({data,receivedAt:state.receivedAt}));}catch{}render();
    if(mapReady&&locationsChanged)fitMap('campus');
    if(pendingNativeDevice&&all().some(s=>s.id===pendingNativeDevice)){const id=pendingNativeDevice;pendingNativeDevice=null;setPage('devices');openDevice(id);}
  }
  async function json(url,options={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}}
  async function readData(){const data=await json('/api/stations');storeData(data);return data;}
  function renderProgress(job){const busy=Boolean(job?.running)||state.busy;$('refresh-button').disabled=busy;$('refresh-button').classList.toggle('loading',busy);$('refresh-button').querySelector('span').textContent=busy?'更新中':'刷新状态';$('refresh-progress').hidden=!busy;$('progress-text').textContent=job?.running?`正在查询 ${job.completed} / ${job.total} 台设备…`:'正在读取最新状态…';}
  async function monitor(){
    try{const data=await readData();state.busy=Boolean(data.refresh.running);renderProgress(data.refresh);if(state.busy)pollTimer=setTimeout(monitor,1200);else{render();toast(`查询完成，${valid(all()).length} / ${all().length} 台状态有效`);}}
    catch{state.busy=false;renderProgress();toast('连接暂时中断，保留已有记录，请稍后重试。');}
  }
  async function refresh(ids){
    if(state.busy)return;
    state.busy=true;renderProgress();clearTimeout(pollTimer);
    try{await json('/api/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ids?{ids}:{})});await monitor();}
    catch{state.busy=false;renderProgress();toast('状态更新暂时失败，请检查手机网络后重试。');}
  }
  function render(){
    if(!state.data)return;
    const records=all(),live=valid(records);
    $('stat-devices').innerHTML=records.length+'<small>台</small>';$('tab-device-count').textContent=records.length;
    $('location-summary').textContent=`${records.length} 台设备 · ${locations().length} 处地点，地图标点为方位示意。`;$('stat-ports').innerHTML=state.data.stats.registered_ports+'<small>个</small>';
    $('stat-free').innerHTML=(live.length?free(records):'—')+'<small>个</small>';
    $('stat-free').closest('.stat').dataset.availability=availability(records).key;
    $('stat-fresh').textContent=`${live.length} / ${records.length} 台有效，仅统计当前记录`;
    $('live-status').textContent=live.length?`${live.length}/${records.length} 台已更新 · ${dt(state.data.server_time)}`:'历史快照 · 等待实时更新';$('live-status').classList.toggle('fresh',live.length>0);
    renderLocations();renderSite();renderList();renderMarker();if(state.dialogId)renderDialog();renderProgress(state.data.refresh);
    $('snapshot-explanation').textContent=`仓库历史快照时间为 ${dt(state.data.repository.snapshot_at,true)}（北京时间）。历史快照不计入当前空闲数。实时查询失败后仍可查看快照，但页面会明确标记。`;
  }
  function renderLocations(){
    const sites=locations(),site=selectedSite();if(!site)return;
    state.selectedLocation=site.id;
    $('stat-locations').innerHTML=sites.length+'<small>处</small>';
    $('map-location-count').textContent=sites.length+' 处地点 · 方位示意';
    const picker=$('location-picker');
    if(picker.dataset.catalog!==JSON.stringify(sites)){
      picker.dataset.catalog=JSON.stringify(sites);
      picker.replaceChildren(...sites.map((l,i)=>{const b=document.createElement('button');b.dataset.location=l.id;b.innerHTML=`<i>${i+1}</i><span>${esc(l.name)}</span><small>${l.device_ids.length} 台</small>`;return b;}));
      $('location-select').replaceChildren(new Option('全部地点',''),...sites.map(l=>new Option(l.name,l.id)));
    }
    picker.querySelectorAll('button').forEach(b=>{const place=sites.find(l=>l.id===b.dataset.location),level=availability(atSite(place)),active=place.id===site.id;b.classList.toggle('active',active);b.dataset.availability=level.key;b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-label',`${place.name}，${level.label}，${level.complete?level.known+' 个空闲':'当前空位待确认'}`);});
    $('location-filter').textContent=site.name;
    $('location-select').value=state.filter==='location'?site.id:'';
  }
  function renderSite(){
    const site=selectedSite();if(!site)return;
    const devices=siteDevices(),live=valid(devices),known=free(devices),capacity=devices.reduce((n,s)=>n+s.expected_ports,0),complete=live.length===devices.length&&devices.length>0;
    const level=availability(devices);
    $('site-card').dataset.availability=level.key;$('map-place').dataset.availability=level.key;
    $('site-title').textContent=site.name;
    $('site-provenance').textContent=site.description||'文档确认设备归属 · 地图位置为示意';
    $('site-index').textContent=`地图地点 ${String(locations().indexOf(site)+1).padStart(2,'0')} / ${String(locations().length).padStart(2,'0')}`;
    $('site-capacity').textContent=`${devices.length} 台 / ${capacity} 口`;
    $('map-place-name').textContent=site.name;$('map-place-capacity').textContent=`${devices.length} 台设备 · ${capacity} 个插座`;
    $('map-focus').title='聚焦'+site.name;
    $('site-free').textContent=live.length?known:'—';$('site-free-unit').textContent=complete?'个空闲插座':'个已知空闲';
    $('site-badge').textContent=level.label;
    $('capacity-bar').firstElementChild.style.width=(live.length&&capacity?known/capacity*100:0)+'%';
    $('site-update').textContent=complete?`${devices.length} 台设备已更新 · ${dt(devices.map(s=>s.last_success).filter(Boolean).sort().at(-1))}`:live.length?`${live.length} / ${devices.length} 台已更新，其余状态待确认`:'当前空位未知，历史快照不计入可用数量';
    $('site-favorite').setAttribute('aria-pressed',String(devices.length>0&&devices.every(s=>state.favorites.has(s.id))));
    $('site-devices').replaceChildren(...devices.map(s=>{const b=document.createElement('button');b.className='mini-device';b.dataset.device=s.id;b.dataset.availability=availability([s]).key;b.innerHTML=`<b>${esc(named(s))}</b><span>${esc(s.id.slice(-4))} · ${fresh(s)?`<strong>${s.counts.free}</strong> / ${s.counts.total} 空闲`:'状态待更新'}</span>`;b.setAttribute('aria-label',`${named(s)}，${availability([s]).label}，${fresh(s)?s.counts.free+' 个空闲':'当前状态未知'}，查看插座`);b.onclick=()=>openDevice(s.id);return b;}));
  }
  function filtered(){
    let records=all().filter(s=>state.page!=='favorites'||state.favorites.has(s.id));
    if(state.filter==='location')records=records.filter(s=>s.location_id===state.selectedLocation);
    if(state.filter==='available')records=records.filter(s=>fresh(s)&&s.counts.free>0);
    const query=state.query.trim().toLowerCase();if(query)records=records.filter(s=>[s.id,named(s),remark(s),locationOf(s)?.name].join(' ').toLowerCase().includes(query));
    return records.sort((a,b)=>state.sort==='free'?(Number(fresh(b))-Number(fresh(a))||((fresh(b)?b.counts.free:-1)-(fresh(a)?a.counts.free:-1))||a.id.localeCompare(b.id)):state.sort==='favorites'?(Number(state.favorites.has(b.id))-Number(state.favorites.has(a.id))||a.id.localeCompare(b.id)):a.id.localeCompare(b.id));
  }
  function renderList(){
    if(!state.data)return;
    const records=filtered();$('results-caption').textContent=`显示 ${records.length} 台 · 共 ${all().length} 台已导入设备`;$('empty-results').hidden=records.length>0;
    $('device-list').replaceChildren(...records.map(s=>{
      const card=document.createElement('article');card.className='device-card';card.tabIndex=0;card.dataset.device=s.id;card.setAttribute('aria-label',named(s)+'，'+(fresh(s)?s.counts.free+' 个空闲，':'当前状态待更新，')+'查看详情');
      const site=locationOf(s),isFresh=fresh(s),level=availability([s]);
      card.dataset.availability=level.key;
      card.innerHTML=`<div class="device-card-top"><div><h3>${esc(named(s))}</h3><span class="confidence-tag confirmed">${s.location_status==='user_named'?'文档名称':'仓库原名'}</span></div><button class="icon-button favorite" aria-label="${state.favorites.has(s.id)?'取消收藏':'收藏'} ${esc(named(s))}" aria-pressed="${state.favorites.has(s.id)}">${icon('star')}</button></div><p class="device-name">${esc(s.id)} · ${esc(site?.name||'地点未收录')}</p><p class="reference-name">${remark(s)?'备注：'+esc(remark(s)):'地图 '+String(locations().indexOf(site)+1).padStart(2,'0')+' · 点击查看插座与地图位置'}</p><div class="device-card-count ${isFresh?'':'historical'}"><strong>${s.counts.total?s.counts.free:'—'}</strong><span>${isFresh?'空闲':'快照 / 上次空闲'} / ${s.counts.total||s.expected_ports} 口</span><span class="availability-badge device-level">${level.label}</span></div><div class="device-bar"><span style="width:${s.counts.total?s.counts.free/s.counts.total*100:0}%"></span></div><div class="device-card-footer"><span>${esc(sourceLabel(s))}</span>${icon('arrow')}</div>`;
      card.querySelector('.favorite').onclick=e=>{e.stopPropagation();toggleFavorite(s.id);};
      card.onclick=()=>openDevice(s.id);card.onkeydown=e=>{if(e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openDevice(s.id);}};return card;
    }));
  }
  function toggleFavorite(id){if(state.favorites.has(id))state.favorites.delete(id);else state.favorites.add(id);save();render();}
  function setPage(page,{reset=false}={}){
    if(!['map','devices','favorites'].includes(page))page='map';
    state.page=page;if(reset){state.filter='all';state.query='';$('search-input').value='';}
    $('map-page').hidden=page!=='map';$('devices-page').hidden=page==='map';
    document.querySelectorAll('[data-page]').forEach(b=>{const active=b.dataset.page===page;b.classList.toggle('active',active);if(b.getAttribute('role')==='tab')b.setAttribute('aria-selected',String(active));else if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    $('page-title').innerHTML=page==='map'?'先看空位，再出发<span>。</span>':page==='favorites'?'常用的，就放在手边<span>。</span>':'校园设备，一眼看清<span>。</span>';
    $('page-description').textContent=page==='map'?'一张校园地图，让下一次充电少一点等待。':page==='favorites'?'收藏的设备保存在这台浏览器，随时查看。':'按设备名称、编号或当前空闲情况找到设备。';
    $('devices-heading').textContent=page==='favorites'?'我的收藏':'全部充电设备';
    document.querySelectorAll('[data-filter]').forEach(b=>{const active=b.dataset.filter===state.filter;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    history.replaceState(null,'','#'+page);renderLocations();renderList();if(page==='map'&&mapReady)requestAnimationFrame(()=>{if(!lastWidth)fitMap('focus');});
  }
  function openDevice(id){state.dialogId=id;state.port=null;renderDialog();if(!$('device-dialog').open)$('device-dialog').showModal();}
  function renderDialog(){
    const s=all().find(x=>x.id===state.dialogId);if(!s)return;
    const isFresh=fresh(s),site=locationOf(s),level=availability([s]);
    let warning=s.source==='unqueried'?'尚未获取该设备的插座状态，请更新后查看。':s.source==='repository_snapshot'?`这是 ${dt(s.snapshot_at,true)} 的历史快照，不代表当前可用状态。`:isFresh?'':'此记录已过期，请更新后再判断空位。';
    if(s.error)warning+=' '+s.error;
    const c=s.counts;
    $('dialog-content').innerHTML=`<h2 id="dialog-title">${esc(named(s))}</h2><p class="dialog-code">${esc(s.id)}</p><p class="dialog-location">${esc(site?.description||site?.name||'地点未收录')} · ${s.location_status==='user_named'?'用户标注':'仓库地点'} · 方位示意</p>${remark(s)?`<p class="dialog-reference">本地备注：${esc(remark(s))}</p>`:''}${warning?`<p class="dialog-alert" role="status">${esc(warning)}</p>`:''}<div class="dialog-summary" data-availability="${level.key}"><div><strong>${c.total?c.free:'—'}</strong><span>${isFresh?'空闲':'快照 / 上次空闲'}</span></div><span class="availability-badge">${level.label}</span><b>${c.busy} 占用</b><b>${c.other} 其他</b><span>共 ${c.total||s.expected_ports} 口</span></div><p class="dialog-time">${esc(sourceLabel(s))} · 北京时间</p><div class="port-grid ${isFresh?'':'port-history'}" aria-label="插座状态"></div><p class="port-detail" id="port-detail">点选插座，查看状态</p><div class="port-legend"><span><i></i>空闲</span><span><i class="busy"></i>占用</span><span><i class="other"></i>故障 / 其他</span></div><div class="dialog-actions"><button id="dialog-favorite">${state.favorites.has(s.id)?'★ 已收藏':'☆ 收藏设备'}</button><button id="dialog-rename">添加备注</button><button id="dialog-map">在地图查看</button><button id="dialog-refresh">更新此设备</button></div>`;
    const grid=$('dialog-content').querySelector('.port-grid');
    for(const p of s.ports){const button=document.createElement('button');button.className='port '+(p.state===1?'free':p.state===2?'busy':'other');button.dataset.port=p.num;button.setAttribute('aria-label',`${p.num} 号插座，${p.label}${isFresh?'':'，历史记录'}`);button.setAttribute('aria-pressed',String(state.port===p.num));button.innerHTML=`<strong>${String(p.num).padStart(2,'0')}</strong><span>${esc(p.label)}</span>`;button.onclick=()=>{state.port=p.num;grid.querySelectorAll('.port').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.port)===p.num)));$('port-detail').textContent=`${p.num} 号插座 · ${p.label}${isFresh?'':' · 历史记录'}`;};grid.append(button);}
    const selected=s.ports.find(p=>p.num===state.port);if(selected)$('port-detail').textContent=`${selected.num} 号插座 · ${selected.label}${isFresh?'':' · 历史记录'}`;
    $('dialog-favorite').onclick=()=>toggleFavorite(s.id);
    $('dialog-rename').onclick=()=>{const name=prompt('给设备添加本地备注（最多 24 字，留空删除备注）',state.names[s.id]||'');if(name===null)return;state.names[s.id]=name.trim().slice(0,24);save();render();};
    $('dialog-map').onclick=()=>{$('device-dialog').close();setPage('map');selectSite(s.location_id,{focus:true});$('map-page').scrollIntoView({behavior:'smooth',block:'start'});};
    $('dialog-refresh').disabled=state.busy;$('dialog-refresh').onclick=()=>refresh([s.id]);
  }
  function selectSite(id=state.selectedLocation,{focus=false,scroll=false}={}){
    if(!locations().some(l=>l.id===id))return;
    state.selectedLocation=id;save();renderLocations();renderSite();renderMarker();
    if(state.filter==='location')renderList();
    if(focus)fitMap('focus');
    if(scroll)$('site-card').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'center'});
  }
  function setCamera(next){Object.assign(camera,next);camera.w=Math.max(180,Math.min(4800,camera.w));camera.h=camera.w*Math.max(1,$('map-stage').clientHeight)/Math.max(1,$('map-stage').clientWidth);camera.x=Math.max(-1800,Math.min(2800,camera.x));camera.y=Math.max(-1500,Math.min(2500,camera.y));$('campus-map').setAttribute('viewBox',`${camera.x} ${camera.y} ${camera.w} ${camera.h}`);renderMarker();}
  function fitMap(mode){
    const site=selectedSite()||{map_x:337,map_y:1086};
    const points=locations().length?locations():[site],left=Math.min(...points.map(l=>l.map_x))-160,top=Math.min(...points.map(l=>l.map_y))-110;
    const overview={x:left,y:top,w:Math.max(...points.map(l=>l.map_x))+160-left,h:Math.max(...points.map(l=>l.map_y))+170-top};
    const box=mode==='focus'?{x:site.map_x-215,y:site.map_y-230,w:430,h:460}:overview;
    const width=$('map-stage').clientWidth,height=$('map-stage').clientHeight;if(!width||!height)return;
    const w=Math.max(box.w,box.h*width/height),h=w*height/width;setCamera({x:box.x+(box.w-w)/2,y:box.y+(box.h-h)/2,w,h});lastWidth=width;
  }
  function zoomAt(factor,cx,cy){const bounds=$('campus-map').getBoundingClientRect();const rx=(cx??bounds.width/2)/bounds.width,ry=(cy??bounds.height/2)/bounds.height;const w=Math.max(180,Math.min(4800,camera.w/factor)),h=w*bounds.height/bounds.width;setCamera({x:camera.x+rx*(camera.w-w),y:camera.y+ry*(camera.h-h),w,h});}
  function svgElement(type,attributes={},text){const node=document.createElementNS(SVG,type);for(const [k,v] of Object.entries(attributes))node.setAttribute(k,String(v));if(text)node.textContent=text;return node;}
  async function loadMap(){
    try{
      const map=await json('/assets/campus-map.json');const group=$('map-features');const fragment=document.createDocumentFragment();
      for(const f of map.features){
        const attr={fill:f.fill,stroke:f.stroke||'none','stroke-width':f.width||1};let node;
        if(f.type==='polygon'||f.type==='line'){node=svgElement(f.type==='line'?'polyline':'polygon',{...attr,points:f.points.map(p=>p.join(',')).join(' '),...(f.type==='line'?{stroke:f.fill,fill:'none'}:{})});}
        else if(f.type==='circle')node=svgElement('circle',{...attr,cx:f.x,cy:f.y,r:f.r});
        else if(f.type==='rect')node=svgElement('rect',{...attr,x:f.x,y:f.y,width:f.w,height:f.h,rx:f.r});
        else if(f.type==='text')node=svgElement('text',{x:f.x,y:f.y,fill:f.fill,'font-size':f.size,'font-weight':f.bold?650:400,'font-family':'Microsoft YaHei, sans-serif','text-anchor':f.anchor==='lm'?'start':f.anchor==='rm'?'end':'middle','dominant-baseline':'central',...(f.halo?{stroke:map.background,'stroke-width':6,'paint-order':'stroke'}:{stroke:'none'})},f.text);
        if(node)fragment.append(node);
      }
      group.replaceChildren(fragment);mapReady=true;$('map-loading').hidden=true;fitMap('campus');
      new ResizeObserver(()=>{if($('map-stage').clientWidth&&$('map-stage').clientWidth!==lastWidth){fitMap('campus');}}).observe($('map-stage'));
    }catch{$('map-loading').textContent='地图暂未加载，请刷新页面。设备列表仍可使用。';}
  }
  function renderMarker(){
    if(!mapReady)return;
    const stage=$('map-stage'),k=camera.w/Math.max(1,stage.clientWidth),compact=stage.clientWidth<500&&camera.w>650,sites=locations();
    const root=$('map-markers'),occupied=[],pins=sites.map(l=>({x:(l.map_x-camera.x)/k,y:(l.map_y-camera.y)/k}));
    const ordered=[...sites].sort((a,b)=>Number(b.id===state.selectedLocation)-Number(a.id===state.selectedLocation));
    for(const loc of ordered){
      const index=sites.indexOf(loc),records=atSite(loc),live=valid(records),count=free(records),complete=live.length===records.length&&records.length>0,active=loc.id===state.selectedLocation;
      const level=availability(records),color='var(--availability-fill)',r=active?17:13;
      let marker=document.getElementById('marker-'+loc.id);
      if(!marker){marker=svgElement('g',{id:'marker-'+loc.id,'data-location':loc.id,role:'button',tabindex:0,class:'map-marker'});root.append(marker);}
      marker.dataset.availability=level.key;
      marker.setAttribute('transform',`translate(${loc.map_x} ${loc.map_y})`);
      marker.setAttribute('aria-label',`${index+1} ${loc.name}，${records.length} 台设备，${level.label}，${complete?count+' 个空闲':'当前空位待确认'}`);marker.setAttribute('aria-pressed',String(active));
      const pinPosition=pins[index],visible=pinPosition.x>=-r&&pinPosition.x<=stage.clientWidth+r&&pinPosition.y>=-r&&pinPosition.y<=stage.clientHeight+r;
      marker.style.display=visible?'':'none';if(!visible)continue;
      const children=[];
      if(active)children.push(svgElement('circle',{r:23*k,fill:'var(--availability-soft)',opacity:.8}));
      if(!compact||active){
        const pin=pins[index],width=loc.name.length*11+22,height=26;
        const offsets=[...(loc.id==='teachers'?[[75,0]]:[]),[0,-36],[0,36],[width/2+22,0],[-width/2-22,0],[width/2+16,-35],[-width/2-16,-35],[width/2+16,36],[-width/2-16,36],[0,-68],[0,68]];
        let best=null;
        for(const [dx,dy] of offsets){
          const x=Math.max(8,Math.min(stage.clientWidth-width-8,pin.x+dx-width/2)),y=Math.max(12,Math.min(stage.clientHeight-height-84,pin.y+dy-height/2));
          const rect={x,y,w:width,h:height};
          const collisions=occupied.filter(o=>x<o.x+o.w+5&&x+width+5>o.x&&y<o.y+o.h+5&&y+height+5>o.y).length+pins.filter(p=>p.x>x-15&&p.x<x+width+15&&p.y>y-15&&p.y<y+height+15).length;
          if(!best||collisions<best.collisions)best={...rect,collisions};if(!collisions)break;
        }
        occupied.push(best);const dx=(best.x-pin.x)*k,dy=(best.y-pin.y)*k;
        children.push(svgElement('line',{x1:0,y1:0,x2:dx+width*k/2,y2:dy+height*k/2,stroke:active?'#698f69':'#a8b6a0','stroke-width':k}));
        children.push(svgElement('rect',{x:dx,y:dy,width:width*k,height:height*k,rx:8*k,fill:active?color:'#fffefb',stroke:active?color:'#dfe7d8','stroke-width':k}));
        children.push(svgElement('text',{x:dx+width*k/2,y:dy+height*k/2,fill:active?'var(--availability-on-fill)':'#38573c','text-anchor':'middle','dominant-baseline':'central','font-size':11*k,'font-weight':600},loc.name));
      }
      children.push(svgElement('circle',{r:r*k,class:'marker-pin',fill:color,stroke:'white','stroke-width':2.5*k}));
      children.push(svgElement('text',{x:0,y:k,fill:'var(--availability-on-fill)','text-anchor':'middle','dominant-baseline':'central','font-size':12*k,'font-weight':650},String(index+1)));
      marker.replaceChildren(...children);
    }
    root.querySelectorAll('.map-marker').forEach(m=>m.style.filter=m.dataset.location===state.selectedLocation?'drop-shadow(0 2px 3px #25452e22)':'');
  }
  function bindMap(){
    const svg=$('campus-map'),pointers=new Map();let moved=false,markerPressed=null,start=null;
    $('map-markers').addEventListener('keydown',e=>{const pin=e.target.closest('[data-location]');if(pin&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectSite(pin.dataset.location);}});
    function geometry(){const list=[...pointers.values()];return list.length>=2?{x:(list[0].x+list[1].x)/2,y:(list[0].y+list[1].y)/2,d:Math.hypot(list[0].x-list[1].x,list[0].y-list[1].y)}:list[0];}
    svg.addEventListener('pointerdown',e=>{if(!mapReady)return;if(pointers.size===0){moved=false;markerPressed=e.target.closest('[data-location]')?.dataset.location||null;start={x:e.clientX,y:e.clientY};}pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size>1)moved=true;svg.setPointerCapture(e.pointerId);});
    svg.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;const last=geometry();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});const current=geometry();const dx=current.x-last.x,dy=current.y-last.y;if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>3)moved=true;if(pointers.size>=2&&last.d>0){const r=svg.getBoundingClientRect();zoomAt(current.d/last.d,current.x-r.left,current.y-r.top);}setCamera({x:camera.x-dx*camera.w/svg.clientWidth,y:camera.y-dy*camera.h/svg.clientHeight});});
    const release=e=>{const tap=e.type==='pointerup'&&pointers.size===1&&markerPressed&&!moved;pointers.delete(e.pointerId);if(tap)selectSite(markerPressed);};svg.addEventListener('pointerup',release);svg.addEventListener('pointercancel',release);svg.addEventListener('lostpointercapture',e=>pointers.delete(e.pointerId));
    svg.addEventListener('wheel',e=>{if(!mapReady)return;e.preventDefault();const r=svg.getBoundingClientRect();zoomAt(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top);},{passive:false});
    svg.addEventListener('keydown',e=>{if(e.target!==svg)return;if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(1.3);}else if(e.key==='-'){e.preventDefault();zoomAt(1/1.3);}else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const step=camera.w*.08;setCamera({x:camera.x+(e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0),y:camera.y+(e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0)});}});
    $('map-zoom-in').onclick=()=>zoomAt(1.3);$('map-zoom-out').onclick=()=>zoomAt(1/1.3);$('map-focus').onclick=()=>fitMap('focus');$('map-overview').onclick=()=>fitMap('campus');$('map-place').onclick=()=>selectSite(state.selectedLocation,{scroll:true});
  }
  document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{setPage(b.dataset.page,{reset:true});window.scrollTo({top:0,behavior:'instant'});});
  document.querySelectorAll('a[href="#map"]').forEach(a=>a.onclick=e=>{e.preventDefault();setPage('map',{reset:true});window.scrollTo({top:0});});
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;setPage(state.page);});
  $('search-input').oninput=e=>{state.query=e.target.value;renderList();};$('sort-select').onchange=e=>{state.sort=e.target.value;renderList();};
  $('clear-filters').onclick=()=>setPage(state.page,{reset:true});
  $('site-favorite').onclick=()=>{const ids=siteDevices().map(s=>s.id),remove=ids.every(id=>state.favorites.has(id));ids.forEach(id=>remove?state.favorites.delete(id):state.favorites.add(id));save();render();toast(remove?'已取消收藏此处设备':'已收藏此处设备');};
  $('site-devices-button').onclick=()=>{state.filter='location';state.query='';$('search-input').value='';setPage('devices');$('devices-page').scrollIntoView({behavior:'smooth',block:'start'});};
  $('all-devices-button').onclick=()=>{state.filter='all';state.query='';$('search-input').value='';setPage('devices');$('devices-page').scrollIntoView({behavior:'smooth',block:'start'});};
  $('location-picker').onclick=e=>{const b=e.target.closest('[data-location]');if(b)selectSite(b.dataset.location,{focus:true});};
  $('location-select').onchange=e=>{if(e.target.value){state.selectedLocation=e.target.value;save();state.filter='location';}else state.filter='all';setPage(state.page);};
  $('refresh-button').onclick=()=>refresh();$('auto-refresh').checked=state.auto;$('auto-refresh').onchange=e=>{state.auto=e.target.checked;save();};
  for(const id of ['about-button','source-button'])$(id).onclick=()=>$('about-dialog').showModal();
  document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  for(const id of ['device-dialog','about-dialog'])$(id).addEventListener('click',e=>{if(e.target===$(id)){const r=$(id).getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$(id).close();}});
  $('device-dialog').addEventListener('close',()=>{state.dialogId=null;state.port=null;});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.auto&&!state.busy)refresh();});
  window.addEventListener('charge-open-device',e=>{if(typeof e.detail!=='string')return;pendingNativeDevice=e.detail;if(all().some(s=>s.id===pendingNativeDevice)){const id=pendingNativeDevice;pendingNativeDevice=null;setPage('devices');openDevice(id);}});
  setPage(location.hash.slice(1)||'map');bindMap();loadMap();
  (async()=>{try{const data=await readData();if(data.refresh.running){state.busy=true;monitor();}else refresh();}catch{try{const cached=JSON.parse(localStorage.getItem('stu-charge-web-last-data-v6')||'null');if(cached){state.data=cached.data;state.receivedAt=cached.receivedAt;render();}}catch{}toast('暂时无法读取状态，请关闭后重新打开应用。');}})();
  autoTimer=setInterval(()=>{if(!document.hidden&&state.auto&&!state.busy)refresh();},60000);
  setInterval(()=>{if(!document.hidden&&state.data)render();},30000);
})();
