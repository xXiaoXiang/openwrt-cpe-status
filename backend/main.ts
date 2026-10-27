import { createServer } from 'node:http'
import { readFile, chmod, mkdir, unlink } from 'node:fs/promises'
import { resolve, dirname, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SerialTransport, type AtTransport } from './transport.ts'
import { Engine, identify, loadAdapters } from './engine.ts'
import { OpenWrtHost } from './host.ts'
import { ModemService } from './service.ts'
import { exampleConfig, type ServiceConfig } from './config.ts'
import { DemoHost, DemoTransport } from './demo.ts'
import { unsupportedResult } from '../shared/availability.ts'

const args = process.argv.slice(2), demo = args.includes('--demo')
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback }
const base = dirname(fileURLToPath(import.meta.url))
const config: ServiceConfig = demo ? { ...exampleConfig, adapterDirectory: resolve(base, 'adapters'), allowWrites: true, stateDirectory: resolve(base, 'demo-state') } : JSON.parse(await readFile(option('--config', '/etc/openwrt-modem/config.json'), 'utf8'))
if (!Array.isArray(config.validatedOperations) || typeof config.allowWrites !== 'boolean' || typeof config.lpac?.enabled !== 'boolean') throw new Error('Invalid service configuration')
const adapters = await loadAdapters(config.adapterDirectory)
const transport: AtTransport = demo ? new DemoTransport() : new SerialTransport(config.device)
if (transport instanceof SerialTransport) await transport.connect()
let selected
try { selected = await identify(transport, adapters) }
catch (error) { await transport.close(); throw error }
if (config.adapterId && selected.adapter.id !== config.adapterId) { await transport.close(); throw new Error('Detected model does not match configured adapter') }
if (!/R11/.test(selected.revision)) console.warn('Firmware differs from the R11 baseline; validate the adapter before writes')
const engine = new Engine(selected.adapter, transport, config.allowWrites, new Set(config.validatedOperations))
const service = new ModemService(engine, demo ? new DemoHost('wwan') : new OpenWrtHost(config.networkInterface), config, demo)

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return }
      if (request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403); response.end(); return }
      let raw = ''
      for await (const chunk of request) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 65536) throw new Error('Request too large') }
      const body: unknown = raw ? JSON.parse(raw) : {}
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected JSON object')
      const result = await service.dispatch(request.method ?? 'GET', url.pathname + url.search, body as Record<string, unknown>)
      response.setHeader('Content-Type', typeof result === 'string' ? (url.pathname === '/api/at' ? 'text/plain; charset=utf-8' : 'application/x-ndjson') : 'application/json')
      response.end(typeof result === 'string' ? result : JSON.stringify(result))
      return
    }
    if (!demo) { response.writeHead(404); response.end(); return }
    const webRoot = resolve(base, 'www'), path = resolve(webRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!path.startsWith(webRoot + sep)) { response.writeHead(403); response.end(); return }
    const contents = await readFile(path)
    response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.css': 'text/css' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream')
    response.end(contents)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(message.startsWith('Unsupported:') ? unsupportedResult(message.slice(12).trim()) : { status: /ModemReadDeferred|State changed during read/.test(message) ? 'deferred' : 'error', message, ...(/ModemReadDeferred/.test(message) ? { retry_after_ms: 30_000 } : {}) }))
  }
})
server.requestTimeout = 200_000
server.headersTimeout = 10_000
if (demo) {
  server.listen(Number(option('--port', '4780')), '127.0.0.1', () => console.log(`DEMO ONLY: http://127.0.0.1:${(server.address() as { port: number }).port}`))
} else {
  await mkdir(dirname(config.socketPath), { recursive: true })
  // Fail on an existing socket: never replace another live daemon's listener.
  server.listen(config.socketPath, () => { void chmod(config.socketPath, 0o660); console.log(`Modem API ready on ${config.socketPath}`) })
}
server.on('error', error => { console.error(error); void transport.close().finally(() => process.exit(1)) })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close()
  server.closeAllConnections()
  void transport.close().then(async () => { if (!demo) await unlink(config.socketPath).catch(() => {}); process.exit(0) })
})
