// Headless browser smoke check with an isolated HTTP API; no router access.
import { createServer as createHttpServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir,writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createServer as createViteServer } from 'vite'
import type { ApnSettings,ApnStatus,ApnDeleteRequest } from '../shared/apn-settings.ts'

const destination=resolve('build/apn-ui-check'); await mkdir(destination,{recursive:true})
const entry=resolve(destination,'entry.ts')
await writeFile(entry,`import React from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider,createTheme,CssBaseline} from '@mui/material';
import Operators from '/src/pages/Operators.tsx';
import {CapabilitiesProvider} from '/src/contexts/CapabilitiesContext.tsx';
import {DashboardDataContext} from '/src/contexts/DashboardDataContext.ts';
function TestApp() { const [mode,setMode]=React.useState<'light'|'dark'>('light'); (window as any).setApnTestTheme=setMode; return React.createElement(ThemeProvider,{theme:createTheme({palette:{mode}})},React.createElement(CssBaseline),React.createElement(CapabilitiesProvider,null,React.createElement(DashboardDataContext.Provider,{value:{data:{networkInfo:null}} as any},React.createElement(Operators)))); }
createRoot(document.getElementById('root')!).render(React.createElement(TestApp));
`)
const custom:ApnSettings={apn:'custom.one',pdptype:'ipv4',auth:'none',username:'',password:''}
const second:ApnSettings={...custom,apn:'custom.two',pdptype:'ipv4v6'}
let data:ApnStatus={settings:custom,preferred:custom,iccid:'8985203000000000001',active:true,active_apn:custom.apn,active_protocol:'IP',sampled_at:1,
  database:{version:'内置 AOSP',count:1500,source:'AOSP'},choices:[
    {id:'custom:0',source:'custom',carrier:'自定义',settings:custom},{id:'custom:1',source:'custom',carrier:'自定义',settings:second},
    {id:'database:2',source:'database',carrier:'3',settings:{...custom,apn:'mobile.three.com.hk'}},
    {id:'database:3',source:'database',carrier:'3 LTE',settings:{...second,apn:'mobile.lte.three.com.hk'}},
  ]}
const saves:ApnSettings[]=[], deletes:ApnDeleteRequest[]=[]; let checks=0, poll=false
const vite=await createViteServer({configFile:resolve('frontend/vite.config.ts'),server:{middlewareMode:true},appType:'custom'})
const server=createHttpServer(async (req,res)=>{
  if (req.url==='/apn-test') {
    res.setHeader('Content-Type','text/html')
    res.end(await vite.transformIndexHtml('/apn-test',`<html><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll('\\','/')}"></script></body></html>`)); return
  }
  if (req.url?.startsWith('/api/')) {
    res.setHeader('Content-Type','application/json')
    if (req.url==='/api/adaptation') { res.end(JSON.stringify({status:'ok',data:{id:'fixture',writes_enabled:true,demo:false}})); return }
    if (req.url==='/api/airplane-mode') { res.end(JSON.stringify({status:'ok',data:{enabled:false,powered:true,online:true}})); return }
    if (req.url==='/api/network') { res.end(JSON.stringify({status:'ok',data:{registration_status:'registered'}})); return }
    if (req.url.startsWith('/api/operators')) {res.end(JSON.stringify({status:'ok',refreshing:false,state:{mode:0,operator:'Lucky2 Lucky2',plmn:'45400',registered:true,registration:1,sampled_at:Date.now()}}));return}
    if (req.url==='/api/apn/custom' && req.method==='DELETE') {
      let body=''; for await (const chunk of req) body+=chunk
      const target=JSON.parse(body) as ApnDeleteRequest; deletes.push(target)
      data={...data,choices:data.choices?.filter(item=>item.source!=='custom' || JSON.stringify(item.settings)!==JSON.stringify(target.settings))}
      res.end(JSON.stringify({status:'ok',message:'个人 APN 设置已删除',data}));return
    }
    if (req.url==='/api/apn/database') {
      if (req.method==='POST') { checks++; poll=true; res.end(JSON.stringify({status:'pending',job_id:'1-2'})); return }
      if (poll) { data={...data,database:{version:'2026.10.23',count:3276,source:'GNOME MBPI + AOSP'}}; poll=false }
      res.end(JSON.stringify({status:'ok',message:'APN 数据库已更新',data:data.database})); return
    }
    if (req.url==='/api/apn' && req.method==='POST') {
      let body=''; for await (const chunk of req) body+=chunk
      const target=JSON.parse(body) as ApnSettings; saves.push(target); data={...data,settings:target,preferred:target}
    }
    res.end(JSON.stringify({status:'ok',message:'APN 已保存',data})); return
  }
  vite.middlewares(req,res)
})
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
const address=server.address(); if (!address || typeof address==='string') throw new Error('No UI test listener')
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+resolve(destination,'chrome-'+Date.now()),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']})
let browserSocket:WebSocket | undefined, pageSocket:WebSocket | undefined
try {
  const endpoint=await new Promise<string>((done,fail)=>{
    let output=''; const timer=setTimeout(()=>fail(new Error('Chrome startup timeout: '+output)),15000)
    chrome.stderr.on('data',chunk=>{output+=chunk; const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(output); if (match) {clearTimeout(timer);done(match[1])}})
    chrome.on('error',fail)
  })
  const browser=new WebSocket(endpoint); browserSocket=browser
  await new Promise<void>((done,fail)=>{browser.onopen=()=>done();browser.onerror=fail})
  const debug=new URL(endpoint), created=await fetch('http://'+debug.host+'/json/new?about:blank',{method:'PUT'}).then(res=>res.json()) as {webSocketDebuggerUrl:string}
  const socket=new WebSocket(created.webSocketDebuggerUrl); pageSocket=socket
  await new Promise<void>((done,fail)=>{socket.onopen=()=>done();socket.onerror=fail})
  let sequence=0; const waiting=new Map<number,{done:(value:any)=>void;fail:(error:Error)=>void}>(), failures:unknown[]=[]
  socket.onmessage=event=>{ const message=JSON.parse(String(event.data)); if (message.id) {
    const handler=waiting.get(message.id); waiting.delete(message.id)
    if (message.error) handler?.fail(new Error(JSON.stringify(message.error))); else handler?.done(message.result)
  } else if (message.method==='Runtime.exceptionThrown') failures.push(message.params) }
  const command=(method:string,params:object={})=>new Promise<any>((done,fail)=>{const id=++sequence;waiting.set(id,{done,fail});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async (expression:string)=>{
    const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until=async (expression:string)=>{const limit=Date.now()+20000;while(Date.now()<limit) {if(await evaluate(expression)) return;await new Promise(done=>setTimeout(done,100))}throw new Error('UI check timeout: '+expression+' '+JSON.stringify(failures)+' '+await evaluate('document.body.innerText'))}
  await command('Runtime.enable'); await command('Page.enable')
  await command('Page.navigate',{url:'http://127.0.0.1:'+address.port+'/apn-test'})
  await until(`document.querySelector('[data-apn-settings] [role="combobox"]') !== null`)
  await until(`document.querySelector('[data-current-operator]')?.textContent==='Lucky2'`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-active-apn] .MuiChip-label')).filter(node=>node.textContent.includes('APN:') || node.textContent==='已激活').map(node=>node.textContent).join('|')`),'APN: custom.one 已激活')
  assert.equal(await evaluate(`document.querySelector('[data-active-apn]')?.textContent.includes('当前APN')`),false,'active APN label should be omitted')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-apn-fields]')).gridTemplateColumns.split(' ').length`),2,'APN and IP fields should share a row')
  await evaluate(`document.querySelector('[data-apn-settings] [role="combobox"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(`document.querySelectorAll('[role="option"]').length >= 5`)
  const options=await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map(node=>node.textContent)`)
  assert.ok(options.some((value:string)=>value.includes('custom.two')))
  assert.ok(options.some((value:string)=>value.includes('mobile.three.com.hk')))
  assert.ok(options.some((value:string)=>value.includes('mobile.lte.three.com.hk')))
  assert.ok(options.some((value:string)=>value==='手动修改'))
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-apn-source]')).map(node=>node.textContent)`),['来自修改','来自数据库'])
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).filter(node=>node.textContent.includes('mobile.')).some(node=>node.querySelector('button'))`),false,'database option exposed delete')
  await evaluate(`document.querySelector('[data-delete-apn="custom.two"]').click()`)
  await until(`document.querySelector('[data-delete-apn="custom.two"]')?.textContent==='确认删除个人APN设置'`)
  assert.equal(deletes.length,0,'first delete click submitted a request')
  assert.equal(saves.length,0,'delete confirmation saved or selected an APN')
  for (const mode of ['light','dark']) {
    await evaluate(`window.setApnTestTheme('${mode}')`)
    await new Promise(done=>setTimeout(done,150))
    assert.ok((await evaluate(`getComputedStyle(document.querySelector('[data-apn-source="custom"]')).backgroundImage`)).includes(mode==='dark' ? '0.15' : '0.08'))
    for (const width of [1100,390]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
      await new Promise(done=>setTimeout(done,150))
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'APN dropdown overflow at '+mode+'/'+width)
      const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})
      await writeFile(resolve(destination,`apn-menu-${mode}-${width}.png`),Buffer.from(shot.data,'base64'))
      const buttons=await evaluate(`Array.from(document.querySelectorAll('[data-delete-apn]')).map(node=>{const rect=node.getBoundingClientRect();return {text:node.textContent,left:rect.left,right:rect.right,width:innerWidth}})`)
      assert.ok(buttons.every((node:{left:number;right:number;width:number})=>node.left>=0 && node.right<=node.width+1),'inline confirmation outside viewport: '+JSON.stringify(buttons))
    }
  }
  await evaluate(`window.setApnTestTheme('light')`)
  await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).find(node=>node.textContent.includes('mobile.three.com.hk')).click()`)
  const apnInput=`document.getElementById(Array.from(document.querySelectorAll('label')).find(node=>node.textContent==='APN 名称').htmlFor)`
  assert.equal(await evaluate(apnInput+'.value'),'mobile.three.com.hk'); assert.equal(saves.length,0,'selecting an APN submitted a write')
  await evaluate(`Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='保存APN').click()`)
  await until(`document.body.textContent.includes('APN 已保存')`)
  assert.equal(saves.length,1); assert.equal(saves[0].apn,'mobile.three.com.hk')
  await evaluate(`Array.from(document.querySelectorAll('button')).find(node=>node.textContent.includes('检测 APN 数据库更新')).click()`)
  await until(`document.body.textContent.includes('APN 数据库已更新') && document.body.textContent.includes('3276')`)
  assert.equal(checks,1); assert.equal(saves.length,1,'database check redialled or saved an APN')
  await evaluate(`document.querySelector('[data-apn-settings] [role="combobox"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(`document.querySelector('[data-delete-apn="custom.two"]')?.textContent==='删除'`)
  await evaluate(`document.querySelector('[data-delete-apn="custom.two"]').click()`)
  assert.equal(deletes.length,0,'closing dropdown failed to cancel first confirmation')
  await evaluate(`document.querySelector('[data-delete-apn="custom.two"]').click()`)
  await until(`!document.querySelector('[data-delete-apn="custom.two"]') && document.body.textContent.includes('个人 APN 设置已删除')`)
  assert.equal(deletes.length,1); assert.equal(deletes[0].iccid,data.iccid); assert.deepEqual(deletes[0].settings,second)
  assert.equal(saves.length,1,'delete redialled or saved an APN')
  assert.equal(await evaluate(`!!document.querySelector('[role="listbox"]')`),true,'inline delete closed dropdown')
  await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).find(node=>node.textContent.includes('mobile.three.com.hk')).click()`)
  for (const width of [1100,390]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
    await new Promise(done=>setTimeout(done,150))
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'APN controls overflow at '+width)
    const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})
    await writeFile(resolve(destination,'apn-'+width+'.png'),Buffer.from(shot.data,'base64'))
  }
  assert.equal(failures.length,0,'browser runtime errors: '+JSON.stringify(failures))
  console.log(JSON.stringify({operator_name_deduplicated:true,active_apn_combined:true,inline_delete_requires_two_clicks:true,closing_cancels_confirmation:true,delete_once_without_saving:true,source_tints_light_and_dark:true,custom_and_database_choices:true,selection_does_not_save:true,save_once:true,update_does_not_redial:true,desktop_and_mobile_fit:true,screenshots:destination}))
} finally {
  try { browserSocket?.send(JSON.stringify({id:9999,method:'Browser.close'})) } catch {}
  pageSocket?.close(); browserSocket?.close(); chrome.kill()
  await vite.close(); await new Promise<void>(done=>server.close(()=>done()))
}
