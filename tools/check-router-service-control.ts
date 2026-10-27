import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { serviceStatus, serviceControl } from '../openwrt/service-control.ts'

// Exercise the actual ucode interpreter; init actions are replaced by a /tmp
// fixture so start/stop tests cannot affect modem, network or real services.
const root = '/tmp/cpe-service-control-' + process.pid
const fakeInit = `#!/bin/sh
test "$1" != enabled || { test -f ${root}/enabled; exit $?; }
echo "$1" >>${root}/calls
test ! -f ${root}/fail
`
const fakeStatus = (running: number) => serviceStatus.replace('let bus = connect();', 'let bus = {call:function(){return ' + JSON.stringify({ 'cpe-status': { instances: Object.fromEntries(['wwan', 'speed', 'sms'].map((name, i) => [name, { running: i < running }])) } }) + ';}};')
const files = { init: fakeInit, control: serviceControl, running: fakeStatus(3), partial: fakeStatus(1), stopped: fakeStatus(0), unknown: serviceStatus.replace('let bus = connect();', 'let bus = null;') }
const script = [
  'set -eu', `mkdir -m 700 ${root}`,
  ...Object.entries(files).flatMap(([name, content], i) => [`cat >${root}/${name} <<'CPE_SERVICE_${i}'`, content.replaceAll('/etc/init.d/cpe-status', root + '/init'), `CPE_SERVICE_${i}`, `chmod 700 ${root}/${name}`]),
  `touch ${root}/enabled`,
  ...['running','partial','stopped','unknown'].flatMap(name => [`echo '>>> ${name}'`, `${root}/${name} || true`]),
  `rm ${root}/enabled`, `echo '>>> disabled'`, `${root}/running`,
  ...['start','stop','restart','enable','disable'].flatMap(action => [`echo '>>> ${action}'`, `${root}/control ${action}`]),
  `echo '>>> bad-action'`, `${root}/control 'restart;reboot' || true`,
  `echo '>>> extra-service'`, `${root}/control start network || true`,
  `echo '>>> no-action'`, `${root}/control || true`,
  `echo '>>> status-write'`, `${root}/running restart || true`,
  `touch ${root}/fail`, `echo '>>> action-error'`, `${root}/control restart || true`,
  `echo '>>> calls'`, `cat ${root}/calls`,
].join('\n') + '\n'
const output = execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts','root@192.168.6.248','sh -s'], { input: script, encoding: 'utf8', timeout: 30000, windowsHide: true })
const section = (name: string) => output.split('>>> ' + name + '\n')[1]?.split('>>> ')[0].trim()
for (const [name, count] of [['running',3],['partial',1],['stopped',0]] as const) {
  const result = JSON.parse(section(name)!)
  assert.equal(result.status, 'ok'); assert.equal(result.data.running, count)
  assert.equal(result.data.total, 3); assert.equal(result.data.enabled, true)
}
assert.equal(JSON.parse(section('disabled')!).data.enabled, false)
for (const name of ['unknown','bad-action','extra-service','no-action','status-write','action-error']) assert.equal(JSON.parse(section(name)!).status, 'error', name)
for (const name of ['start','stop','restart','enable','disable']) assert.equal(JSON.parse(section(name)!).status, 'ok')
assert.deepEqual(section('calls')!.split('\n'), ['start','stop','restart','enable','disable','restart'])
const acl = JSON.parse(await readFile('build/openwrt-status-package/files/usr/share/rpcd/acl.d/luci-app-cpe-status.json', 'utf8'))['luci-app-cpe-status']
assert.deepEqual(acl.read.file['/usr/libexec/cpe-status-service-status'], ['exec'])
assert.equal(acl.read.file['/usr/libexec/cpe-status-service-control'], undefined)
assert.deepEqual(acl.write.file['/usr/libexec/cpe-status-service-control'], ['exec'])
await mkdir('build/service-control-audit', { recursive: true })
await writeFile('build/service-control-audit/output.txt', output)
console.log(JSON.stringify({ statusScenarios: 5, rejectedInvalidActions: 4, fixedServiceOnly: true, separateReadWriteAcl: true, realServiceChanged: false }))
