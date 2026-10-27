import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { snapshotRoutes, type StatusSnapshot } from '../shared/status-snapshot.ts'
import { profileFixture } from './profile-fixture.ts'
import type { ProfileReply } from '../frontend/src/api/profileCache.ts'

const root = `/tmp/cpe-live-profile-${process.pid}`
const directory = 'build/openwrt-status-package/files/usr/libexec'
const scripts: Record<string, string> = {}
for (const name of await readdir(directory)) {
  const contents = await readFile(`${directory}/${name}`, 'utf8')
  if (contents.startsWith('#!/usr/bin/ucode')) scripts[name] = contents
}
const commands = [profileFixture(root), 'set -eu', `mkdir -p ${root}/cache`, `cp /etc/cpe-status.json ${root}/config.json`,
  ...Object.entries(scripts).flatMap(([name, contents], index) => [`cat >${root}/${name} <<'CPE_LIVE_${index}'`, contents, `CPE_LIVE_${index}`, `chmod 700 ${root}/${name}`, `ucode -c -o /dev/null ${root}/${name}`]),
  `export CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_CACHE=${root}/cache CPE_STATUS_LOCK=/tmp/cpe-status/lock`,
  `export CPE_STATUS_SCRIPT=${root}/cpe-status-snapshot CPE_STATUS_BAND_SCRIPT=${root}/cpe-status-bands CPE_STATUS_CELL_SCRIPT=${root}/cpe-status-cell-locks CPE_STATUS_OPERATOR_SCRIPT=${root}/cpe-status-operators CPE_STATUS_APN_SCRIPT=${root}/cpe-status-apn`,
  `echo '>>> network-before'; uci show network | sed '/^network\\.wwan[.=]/d' | sha256sum`,
  `echo '>>> snapshot'; ${root}/cpe-status-snapshot --refresh`,
  `echo '>>> cached'; ${root}/cpe-status-snapshot`,
  `echo '>>> profile'; ${root}/cpe-status-snapshot profile`,
  `for name in bands cell-locks operators apn; do`,
  `  ${root}/cpe-status-$name --refresh`,
  `  echo ">>> $name"`,
  `  ${root}/cpe-status-$name`,
  `done`,
  `echo '>>> network-after'; uci show network | sed '/^network\\.wwan[.=]/d' | sha256sum`,
  `echo '>>> done'`].join('\n') + '\n'
await mkdir('build/profile-live', { recursive: true })
await writeFile('build/profile-live/check.sh', commands)
const output = execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8',process.env.CPE_ROUTER || 'root@192.168.6.248','sh -s'], { input: commands, encoding: 'utf8', timeout: 120000, windowsHide: true })
await writeFile('build/profile-live/output.txt', output)
const section = (name: string) => output.split('>>> ' + name + '\n')[1]?.split('>>> ')[0].trim()
const snapshot = JSON.parse(section('snapshot')!) as StatusSnapshot
const profile = JSON.parse(section('profile')!) as ProfileReply
assert.equal(snapshot.adapter, undefined)
assert.equal(snapshot.profile_key, profile.profile_key)
snapshot.adapter = profile.data
assert.equal(snapshot.error, undefined)
assert.equal(snapshot.adapter?.id, 'quectel-rm500q-gl')
assert.deepEqual(snapshot.warnings ?? {}, {})
assert.deepEqual(JSON.parse(section('cached')!).sampled, snapshot.sampled)
const routes = snapshotRoutes(snapshot)
for (const path of ['/api/device','/api/network','/api/sim','/api/cells','/api/airplane-mode','/api/network-mode']) assert.equal(routes[path].status, 'ok', path)
const results = Object.fromEntries(['bands','cell-locks','operators','apn'].map(name => [name, JSON.parse(section(name)!)]))
for (const name of Object.keys(results)) assert.equal(results[name].status, 'ok', name)
assert.equal(results['cell-locks'].data.lte.status, 'ok')
assert.equal(results['cell-locks'].data.nr.status, 'ok')
assert.equal(section('network-before'), section('network-after'))
const report = { compiledHelpers: Object.keys(scripts).length, profile: snapshot.adapter!.id, usbId: '2c7c0800', cachedGroups: Object.keys(snapshot.sampled), cellCount: (routes['/api/cells'].data as { cells: unknown[] }).cells.length, operatorRead: !!results.operators.state, settings: Object.keys(results), nonWwanInterfacesUnchanged: true }
await writeFile('build/profile-live/report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
