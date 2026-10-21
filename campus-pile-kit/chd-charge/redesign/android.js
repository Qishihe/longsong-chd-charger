(() => {
  'use strict';
  if(!Array.prototype.at)Object.defineProperty(Array.prototype,'at',{value:function(index){const n=Math.trunc(index)||0;return this[n<0?this.length+n:n];},configurable:true,writable:true});
  const host=window.StuAndroid,fetchAsset=window.fetch.bind(window);
  window.fetch=(input,options={})=>{
    const path=typeof input==='string'?input:input.url;
    if(path.startsWith('/api/')){
      try{const reply=JSON.parse(host.request(path,options.body||''));return Promise.resolve(new Response(JSON.stringify(reply.data),{status:reply.status,headers:{'Content-Type':'application/json'}}));}
      catch(error){return Promise.reject(error);}
    }
    return fetchAsset(input,options);
  };
  try{if(!localStorage.getItem('stu-charge-web-preferences'))localStorage.setItem('stu-charge-web-preferences',host.legacyPreferences());}catch{}
  document.addEventListener('DOMContentLoaded',()=>{
    const watch=document.getElementById('native-watch'),auto=document.getElementById('native-auto'),webAuto=document.getElementById('auto-refresh');
    function renderWatch(){try{const status=JSON.parse(host.watchState());watch.checked=Boolean(status.enabled&&status.allowed);document.getElementById('native-watch-note').textContent=status.enabled&&!status.allowed?'通知权限未允许，请重新开启提醒并允许通知。':'系统约每 15 分钟安排检查，省电限制可能延迟提醒。';}catch{watch.disabled=true;}}
    auto.checked=webAuto.checked;auto.onchange=()=>{webAuto.checked=auto.checked;webAuto.dispatchEvent(new Event('change',{bubbles:true}));};
    webAuto.addEventListener('change',()=>auto.checked=webAuto.checked);
    watch.onchange=()=>host.setWatch(watch.checked);
    window.addEventListener('charge-watch-change',renderWatch);
    window.addEventListener('charge-resume',()=>{renderWatch();document.dispatchEvent(new Event('visibilitychange'));});
    renderWatch();
  });
})();
