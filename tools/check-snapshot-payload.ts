import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { statusCollector } from '../openwrt/status-collector.ts'
import { modemControlResult } from '../openwrt/modem-control.ts'
import { createProfileCache, type ProfileReply } from '../frontend/src/api/profileCache.ts'
import { snapshotRoutes, type StatusSnapshot } from '../shared/status-snapshot.ts'

// Isolated copies of existing data; no serial commands or real control jobs.
const root = `/tmp/cpe-payload-check-${process.pid}`
const script = [
  'set -eu', `mkdir -m 700 ${root}`, `mkdir -m 700 ${root}/cache`,
  `trap 'rm -f ${root}/snapshot ${root}/result ${root}/prepare ${root}/cache/control-1-1.json ${root}/cache/snapshot.json ${root}/cache/lock/pid; rmdir ${root}/cache/lock ${root}/cache ${root} 2>/dev/null || true' EXIT`,
  ...Object.entries({ snapshot: statusCollector, result: modemControlResult }).flatMap(([name, source]) => [
    `cat >${root}/${name} <<'CPE_PAYLOAD_SOURCE'`, source, 'CPE_PAYLOAD_SOURCE',
    `chmod 700 ${root}/${name}`, `ucode -c -o /dev/null ${root}/${name}`,
  ]),
  `cat >${root}/prepare <<'CPE_PAYLOAD_PREPARE'`,
  "import { readfile, writefile } from 'fs';",
  `let value = json(readfile('/tmp/cpe-status/snapshot.json'));`,
  `value.host.time = time(); writefile('${root}/cache/snapshot.json', sprintf('%J', value));`,
  `writefile('${root}/cache/control-1-1.json', sprintf('%J', { status: 'ok', device: value.device, profile_key: value.profile_key, interface: value.host.network_interface, snapshot: value }));`,
  'print(sprintf("%J\\n", value));', 'CPE_PAYLOAD_PREPARE',
  "echo '>>> original'", `ucode ${root}/prepare`,
  `export CPE_STATUS_CACHE=${root}/cache CPE_STATUS_SCRIPT=/bin/true`,
  "echo '>>> profile'", `${root}/snapshot profile`,
  "echo '>>> fresh'", `${root}/snapshot`,
  "echo '>>> control'", `${root}/result 1-1`,
  `ucode -e 'import {readfile,writefile} from "fs"; let p="${root}/cache/snapshot.json", v=json(readfile(p)); v.host.time=0; writefile(p,sprintf("%J",v));'`,
  "echo '>>> stale'", `${root}/snapshot`,
  `mkdir ${root}/cache/lock`, `echo 1 >${root}/cache/lock/pid`,
  "echo '>>> locked'", `${root}/snapshot`,
  `rm ${root}/cache/snapshot.json`,
  "echo '>>> deferred'", `${root}/snapshot`,
  "echo '>>> done'",
].join('\n') + '\n'
const output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.6.248', 'sh -s'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
const section = (name: string) => output.split(`>>> ${name}\n`)[1]?.split('>>> ')[0].trim() ?? ''
const original = JSON.parse(section('original')) as StatusSnapshot
const profile = JSON.parse(section('profile')) as ProfileReply
const profiles = createProfileCache()
let requests = 0
const load = async () => { requests++; return profile }
for (const name of ['fresh', 'stale', 'locked', 'control']) {
  const data = JSON.parse(section(name))
  const wire = (name === 'control' ? data.snapshot : data) as StatusSnapshot
  assert.equal(wire.adapter, undefined, name)
  assert.equal(wire.profile_key, profile.profile_key, name)
  assert.deepEqual(wire.raw, original.raw, name)
  assert.deepEqual(wire.sampled, original.sampled, name)
  const hydrated = await profiles.hydrate(wire, load)
  assert.deepEqual(snapshotRoutes(hydrated), snapshotRoutes({ ...wire, adapter: original.adapter }), name)
}
assert.equal(requests, 1)
assert.match(JSON.parse(section('deferred')).error, /ModemReadDeferred/)
const before = Buffer.byteLength(section('original')), after = Buffer.byteLength(section('fresh'))
const report = { before, after, reductionPercent: Math.round((1 - after / before) * 100), ruleRequests: requests, pathsChecked: ['fresh', 'stale', 'locked', 'control', 'deferred'], parsedDataUnchanged: true }
await mkdir('build/snapshot-payload-check', { recursive: true })
await writeFile('build/snapshot-payload-check/report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
