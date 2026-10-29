import { createServer } from 'node:http'
import { mkdir,writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createServer as createViteServer } from 'vite'
import { luciStatusView } from '../openwrt/luci-view.ts'
import { withBrowser } from './browser-check.ts'

const destination=resolve('build/sms-ui-check');await mkdir(destination,{recursive:true})
const entry=resolve(destination,'entry.ts')
await writeFile(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{ThemeProvider,createTheme,CssBaseline}from'@mui/material';import SMS from '/src/pages/SMS.tsx';import{CapabilitiesProvider}from'/src/contexts/CapabilitiesContext.tsx';import{RefreshContext}from'/src/contexts/RefreshContext.tsx';createRoot(document.getElementById('root')!).render(React.createElement(ThemeProvider,{theme:createTheme()},React.createElement(CssBaseline),React.createElement(CapabilitiesProvider,null,React.createElement(RefreshContext.Provider,{value:{refreshInterval:1000,refreshKey:0,setRefreshInterval:()=>{},triggerRefresh:()=>{}}},React.createElement(SMS)))));`)
const rows=[{id:1,archive_ids:[1,2],direction:'incoming',phone_number:'#Notice',timestamp:'2026-10-26T00:00:00Z',content:'Unread notification',status:'received'}, {id:3,direction:'incoming',phone_number:'#Service',timestamp:'2026-10-25T00:00:00Z',content:'Read notification',status:'read'}]
let marks=0,cleanups=0
const vite=await createViteServer({configFile:resolve('frontend/vite.config.ts'),server:{middlewareMode:true},appType:'custom'})
const native = `<!doctype html><meta charset="utf-8"><style>body{font:14px sans-serif;margin:10px}.cbi-tabmenu{display:flex;flex-wrap:wrap;gap:12px;list-style:none;padding:0}.cbi-button{padding:6px 8px}.cbi-section{border:1px solid #ccc;padding:12px}.cbi-value{margin:12px 0}.cbi-value-description{margin-top:6px}a{cursor:pointer}</style><div id="root"></div><script>
window.nativeCalls=[];
function E(tag,attrs,children){var n=document.createElement(tag);Object.entries(attrs||{}).forEach(function(p){if(typeof p[1]==='function')n.addEventListener(p[0],p[1]);else if(p[1]!==false&&p[1]!=null)n.setAttribute(p[0],p[1]===true?'':p[1]);});(Array.isArray(children)?children:[children]).forEach(function(child){if(child!=null)n.append(child.nodeType?child:document.createTextNode(child));});return n;}
var L={bind:function(fn,self){return fn.bind(self)},hasViewPermission:function(){return true},resource:function(path){return '/'+path}};
var fs={exec:async function(path,args){window.nativeCalls.push({path,args});return{code:0,stdout:JSON.stringify({status:'ok',data:path.endsWith('/service-status')?{running:3,total:3,enabled:true,processes:[]}:args[0]==='config'?{path:args[1]||'/etc/cpe-status/sms'}:{path:'/etc/cpe-status/sms',records:3,unread:1,warnings:[]}})}}};
var view={extend:function(value){return value}},poll={add:function(){}},ui={addNotification:function(){throw Error('Unexpected notification')}};
var widget=new Function('view','fs','poll','ui','L','E',${JSON.stringify(luciStatusView)})(view,fs,poll,ui,L,E);widget.load().then(function(state){document.getElementById('root').append(widget.render(state))});
</script>`
const server=createServer(async(req,res)=>{
  if(req.url==='/native'){res.setHeader('Content-Type','text/html');res.end(native);return}
  if(req.url?.startsWith('/cpe-status/')){res.end('<html><body>Embedded content</body></html>');return}
  if(req.url==='/sms-test'){res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/sms-test',`<html><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll('\\','/')}"></script></body></html>`));return}
  if(req.url?.startsWith('/api/')){
    res.setHeader('Content-Type','application/json')
    if(req.url==='/api/adaptation'){res.end(JSON.stringify({status:'ok',data:{id:'fixture',status_only:true,writes_enabled:true,demo:false}}));return}
    if(req.url.startsWith('/api/sms/read')){let text='';for await(const chunk of req)text+=chunk;assert.deepEqual(JSON.parse(text).ids,[1,2]);rows[0].status='read';marks++;res.end(JSON.stringify({status:'ok',data:rows}));return}
    if(req.url.startsWith('/api/sms/cleanup')){if(req.method==='POST')cleanups++;res.end(JSON.stringify({status:'ok',data:{deleted:2},message:'已清理 2 条短信，路由器历史保留'}));return}
    if(req.url.startsWith('/api/sms/stats')){res.end(JSON.stringify({status:'ok',data:{total:2,incoming:2,outgoing:0}}));return}
    res.end(JSON.stringify({status:'ok',data:rows}));return
  }
  vite.middlewares(req,res)
})
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
const address=server.address();if(!address||typeof address==='string')throw new Error('No test server')
try {
  await withBrowser('http://127.0.0.1:'+address.port+'/native',destination,async({command,evaluate,until})=>{
    await until(`document.querySelectorAll('.cbi-tabmenu li').length===7`)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-cpe-settings]')).display`),'none')
    assert.equal(await evaluate(`document.querySelector('.cpe-service-bar').closest('[data-cpe-settings]')!==null`),true)
    await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(n=>n.textContent==='插件设置').click()`)
    await until(`document.querySelector('iframe').style.display==='none' && document.querySelector('[aria-label="短信保存目录"]').value==='/etc/cpe-status/sms'`)
    assert.equal(await evaluate(`document.querySelector('[data-cpe-settings] iframe')===null`),true)
    await evaluate(`document.querySelector('[aria-label="短信保存目录"]').value='/mnt/disk/sms';Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='保存路径').click()`)
    await until(`document.body.textContent.includes('保存成功')`)
    assert.equal(await evaluate(`nativeCalls.some(n=>n.args[0]==='config' && n.args[1]==='/mnt/disk/sms')`),true)
    await evaluate(`Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='检测短信存储').click()`)
    await until(`document.body.textContent.includes('目录可读写')`)
    for(const width of [1100,390,280]){
      await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false})
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'settings overflow at '+width)
      if(width===390)assert.equal(await evaluate(`(()=>{const a=document.querySelector('.cpe-service-state').getBoundingClientRect(),b=document.querySelector('.cpe-service-actions').getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2)<2})()`),true,'service row wrapped despite available space')
      const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(resolve(destination,'settings-'+width+'.png'),Buffer.from(shot.data,'base64'))
    }
    await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(n=>n.textContent==='短信').click()`)
    assert.equal(await evaluate(`document.querySelector('[data-cpe-settings]').style.display`),'none')
    assert.equal(await evaluate(`document.querySelector('iframe').contentWindow.location.hash`),'#/sms')
  })
  await withBrowser('http://127.0.0.1:'+address.port+'/sms-test',destination,async({command,evaluate,until})=>{
    await until(`document.querySelectorAll('[data-sms-unread]').length===2 && document.querySelector('[data-sms-cleanup]')!==null`)
    assert.equal(await evaluate(`document.body.textContent.includes('短信历史存储目录')`),false)
    assert.equal(await evaluate(`document.querySelector('[data-sms-unread] .MuiAvatar-root')!==null`),true)
    assert.equal(await evaluate(`document.querySelectorAll('[data-sms-unread] .MuiBadge-invisible').length`),1)
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:950,deviceScaleFactor:1,mobile:false})
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true)
    const unreadShot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(resolve(destination,'sms-unread-390.png'),Buffer.from(unreadShot.data,'base64'))
    await command('Emulation.setDeviceMetricsOverride',{width:1100,height:950,deviceScaleFactor:1,mobile:false})
    await until(`document.querySelectorAll('[data-sms-unread]').length===2`)
    await evaluate(`Array.from(document.querySelectorAll('[data-sms-conversations] [role=button]')).find(n=>n.textContent.includes('#Notice')).click()`)
    await until(`document.querySelectorAll('[data-sms-unread] .MuiBadge-invisible').length===2`)
    assert.equal(marks,1)
    await evaluate(`document.querySelector('[data-sms-cleanup]').click()`)
    assert.equal(cleanups,0,'first click deleted SMS')
    await until(`document.querySelector('[data-sms-cleanup]').textContent.includes('确认清理')`)
    await evaluate(`document.querySelector('[data-sms-cleanup]').click()`)
    await until(`document.body.textContent.includes('路由器历史保留')`)
    assert.equal(cleanups,1)
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:950,deviceScaleFactor:1,mobile:false})
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true)
    const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(resolve(destination,'sms-390.png'),Buffer.from(shot.data,'base64'))
  })
  console.log('Browser checks passed: native LuCI settings/service row/path check, no SMS path editor, avatar unread badge/read persistence, cleanup confirmation and mobile fit.')
} finally {await vite.close();await new Promise<void>(done=>server.close(()=>done()))}
