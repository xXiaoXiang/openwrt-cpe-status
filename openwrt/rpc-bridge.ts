import { request } from 'node:http'

// rpcd exec plugin. Authentication/authorization is provided by rpcd ACLs;
// the backend itself is only reachable through a local Unix socket.
const mode = process.argv[2], method = process.argv[3]
if (mode === 'list') console.log(JSON.stringify({ read: { path: 'String' }, write: { path: 'String', body: 'String' } }))
else if (mode === 'call' && ['read', 'write'].includes(method)) {
  let input = ''
  for await (const part of process.stdin) { input += part.toString(); if (Buffer.byteLength(input) > 70000) throw new Error('RPC input too large') }
  try {
    const args = JSON.parse(input) as { path: string; body?: string }
    if (typeof args.path !== 'string' || !args.path.startsWith('/api/') || /[\r\n\x00]/.test(args.path)) throw new Error('Invalid API path')
    const body = method === 'write' ? args.body ?? '{}' : ''
    const output = await new Promise<{ content: string; content_type: string }>((resolve, reject) => {
      const call = request({ socketPath: '/var/run/openwrt-modem.sock', path: args.path, method: method === 'read' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 190_000 }, response => {
        let content = ''
        response.on('data', chunk => { content += chunk.toString(); if (Buffer.byteLength(content) > 1048576) { call.destroy(); reject(new Error('RPC output limit exceeded')) } })
        response.on('end', () => resolve({ content, content_type: String(response.headers['content-type'] ?? 'application/json') }))
      })
      call.on('timeout', () => call.destroy(new Error('Modem request timed out')))
      call.on('error', reject)
      call.end(body)
    })
    console.log(JSON.stringify(output))
  } catch (error) { console.log(JSON.stringify({ content: JSON.stringify({ status: 'error', message: String(error) }), content_type: 'application/json' })) }
} else process.exitCode = 1
