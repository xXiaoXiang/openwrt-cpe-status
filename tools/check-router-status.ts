import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { statusCollector } from '../openwrt/status-collector.ts'
import { snapshotRoutes, type StatusSnapshot } from '../shared/status-snapshot.ts'
import assert from 'node:assert/strict'

const script = `
umask 077
cat > /tmp/cpe-status-check.uc <<'CPE_STATUS_UCODE_EOF'
${statusCollector}
CPE_STATUS_UCODE_EOF
chmod 700 /tmp/cpe-status-check.uc
export CPE_STATUS_CACHE=/tmp/cpe-status-check-${process.pid}
export CPE_STATUS_SCRIPT=/tmp/cpe-status-check.uc
echo '>>> first'
ucode /tmp/cpe-status-check.uc
echo '>>> second'
ucode /tmp/cpe-status-check.uc
ucode -e 'import { readfile, writefile } from "fs"; let p = getenv("CPE_STATUS_CACHE") + "/snapshot.json"; let s = json(readfile(p)); for (let key in keys(s.sampled)) s.sampled[key] = time()+60; s.host.time = time()-3; s.sampled.status = time()-3; writefile(p, sprintf("%J", s));'
echo '>>> stale'
ucode /tmp/cpe-status-check.uc
sleep 2
echo '>>> refreshed'
ucode /tmp/cpe-status-check.uc
echo '>>> done'
`
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', chunk => { stdout += chunk.toString() }); child.stderr.on('data', chunk => { stderr += chunk.toString() })
const timer = setTimeout(() => child.kill(), 60000)
await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve()) }); clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/collector.uc', statusCollector)
await writeFile('build/router-audit/collector-output.txt', stdout)
await writeFile('build/router-audit/collector-errors.txt', stderr)
console.log(stderr)
const first = stdout.split('>>> first\n')[1]?.split('>>> second')[0]?.trim(), second = stdout.split('>>> second\n')[1]?.split('>>> stale')[0]?.trim()
if (!first || !second) { console.log(stdout); throw new Error('No snapshots returned') }
const snapshot = JSON.parse(first) as StatusSnapshot, cached = JSON.parse(second) as StatusSnapshot
const stale = JSON.parse(stdout.split('>>> stale\n')[1]?.split('>>> refreshed')[0]?.trim()) as StatusSnapshot
const refreshed = JSON.parse(stdout.split('>>> refreshed\n')[1]?.split('>>> done')[0]?.trim()) as StatusSnapshot
if (snapshot.error || !snapshot.host) throw new Error(snapshot.error ?? 'No host data')
assert.deepEqual(Object.keys(snapshot.sampled).sort(), ['cells', 'identity', 'mode', 'radio', 'roaming', 'sim', 'status', 'temperature'])
assert.deepEqual(snapshot.warnings ?? {}, {})
assert.deepEqual(snapshot.sampled, cached.sampled)
assert.equal(stale.stale, true)
assert.ok(stale.sampled.status <= stale.host.time)
assert.ok(refreshed.sampled.status > stale.sampled.status)
// Deliberately pin the other timestamps ahead of the clock above, so variable
// USB response time cannot expire a 4s group while testing the independent 2s one.
for (const group of ['cells', 'identity', 'sim', 'radio', 'temperature', 'roaming', 'mode']) assert.equal(refreshed.sampled[group], stale.sampled[group], group + ' must not be queried with the 2s status group')
assert.deepEqual(refreshed.warnings ?? {}, {})
await writeFile('build/router-audit/snapshot.json', JSON.stringify(snapshot, null, 2))
const routes = snapshotRoutes(snapshot)
await writeFile('build/router-audit/api-routes.json', JSON.stringify(routes, null, 2))
const stats = routes['/api/stats'].data as { temperature: unknown[]; connection: { ipv4: string[]; ipv6: string[]; ipv6_prefix: string[] }; network_speed: { interfaces: { interface: string; logical_interfaces: string[] }[] } }
const child4 = snapshot.host.networks?.find(row => row.interface === 'wwan_4' && row.up)
for (const address of child4?.['ipv4-address'] ?? []) assert.ok(stats.connection.ipv4.includes(`${address.address}/${address.mask}`), 'MBIM child address reaches connection card')
assert.ok(stats.network_speed.interfaces.some(row => row.logical_interfaces.includes('wwan')), 'logical wwan resolves to physical speed counter')
console.log(JSON.stringify({ source: snapshot.source, port: snapshot.device, samples: snapshot.sampled, warnings: snapshot.warnings, cacheReused: JSON.stringify(snapshot.sampled) === JSON.stringify(cached.sampled), network: routes['/api/network'], cells: routes['/api/cells'], temperatures: stats.temperature.length, connection: stats.connection, speedInterfaces: stats.network_speed.interfaces.map(row => ({ interface: row.interface, aliases: row.logical_interfaces })) }, null, 2))
