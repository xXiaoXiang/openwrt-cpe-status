import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export interface BrowserCheck {
  command(method: string, params?: object): Promise<any>
  evaluate(expression: string): Promise<any>
  until(expression: string): Promise<void>
}

export async function withBrowser(url: string, destination: string, check: (browser: BrowserCheck) => Promise<void>) {
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+resolve(destination,'chrome-'+Date.now()),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']})
  let browserSocket: WebSocket | undefined, pageSocket: WebSocket | undefined
  try {
    const endpoint = await new Promise<string>((done,fail)=>{
      let output=''; const timer=setTimeout(()=>fail(new Error('Chrome startup timeout: '+output)),15000)
      chrome.stderr.on('data',chunk=>{output+=chunk; const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(output); if(match){clearTimeout(timer);done(match[1])}})
      chrome.on('error',fail)
    })
    browserSocket = new WebSocket(endpoint)
    await new Promise<void>((done,fail)=>{browserSocket!.onopen=()=>done();browserSocket!.onerror=fail})
    const debug=new URL(endpoint), created=await fetch('http://'+debug.host+'/json/new?about:blank',{method:'PUT'}).then(res=>res.json()) as {webSocketDebuggerUrl:string}
    const socket=new WebSocket(created.webSocketDebuggerUrl);pageSocket=socket
    await new Promise<void>((done,fail)=>{socket.onopen=()=>done();socket.onerror=fail})
    let sequence=0;const waiting=new Map<number,{done:(value:any)=>void;fail:(error:Error)=>void}>(),errors:unknown[]=[]
    socket.onmessage=event=>{const message=JSON.parse(String(event.data));if(message.id){const handler=waiting.get(message.id);waiting.delete(message.id);if(message.error)handler?.fail(new Error(JSON.stringify(message.error)));else handler?.done(message.result)}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params)}
    const command=(method:string,params:object={})=>new Promise<any>((done,fail)=>{const id=++sequence;waiting.set(id,{done,fail});socket.send(JSON.stringify({id,method,params}))})
    const evaluate=async(expression:string)=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value}
    const until=async(expression:string)=>{const limit=Date.now()+15000;while(Date.now()<limit){if(await evaluate(expression))return;await new Promise(done=>setTimeout(done,100))}throw new Error('UI check timeout: '+expression+' '+JSON.stringify(errors)+' '+await evaluate('document.body.innerText'))}
    await command('Runtime.enable');await command('Page.enable');await command('Page.navigate',{url})
    await check({command,evaluate,until})
    if(errors.length)throw new Error('Browser errors: '+JSON.stringify(errors))
  } finally {
    try{browserSocket?.send(JSON.stringify({id:9999,method:'Browser.close'}))}catch{}
    pageSocket?.close();browserSocket?.close();chrome.kill()
  }
}
