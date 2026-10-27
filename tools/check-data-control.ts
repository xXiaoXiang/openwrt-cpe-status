import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { profileFixture, profileFingerprint } from './profile-fixture.ts'
import { modemControl } from '../openwrt/modem-control.ts'

// Explicit, short integration check. All AT/netifd commands are private mocks.
const root = '/tmp/cpe-data-check-' + Date.now()
const host = process.env.CPE_ROUTER || 'root@192.168.6.248'
const ssh = (script: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', host, 'sh -s'], { input: script + '\n', encoding: 'utf8', timeout: 20000, windowsHide: true }).trim()
const put = (file: string, content: string) => ssh("cat > " + root + '/' + file + " <<'CPE_DATA_EOF'\n" + content + '\nCPE_DATA_EOF')
ssh('umask 077\nmkdir -p ' + root + '/cache ' + root + '/bin\n' + profileFixture(root))
put('control', modemControl)
put('config.json', JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan', moduleQos: false }))
put('bin/sms_tool', '#!/bin/sh\ncase "$4" in\n AT+CGMM) echo RM500Q-GL;;\n AT+CFUN?) echo "+CFUN: 1";;\n *) echo ERROR;;\nesac\n')
put('bin/ip', '#!/bin/sh\nexit 0\n')
put('bin/ubus', String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
let dir=getenv('CPE_DATA_TEST'), path=dir+'/network.json', net=json(readfile(path));
if (ARGV[3]=='dump') print(sprintf('%J',{interface:[{interface:'wwan',proto:'qmi',l3_device:'wwan0',up:net.up,pending:net.pending},{interface:'wwan_4',up:false,'ipv4-address':[]},{interface:'wwan_6',up:false,'ipv6-address':[]}]}));
else if (ARGV[3]=='up') {net.submitted=true; net.up=!net.reject; net.pending=!!net.reject; writefile(path,sprintf('%J',net));}
else die('Unexpected real-network command');
`)
ssh('chmod 700 ' + root + '/control ' + root + '/bin/*')
const environment = 'export CPE_DATA_TEST=' + root + ' CPE_STATUS_CACHE=' + root + '/cache CPE_STATUS_CONFIG=' + root + '/config.json CPE_STATUS_MODEM_DIRECTORY=' + root + '/modem.d\nexport PATH=' + root + '/bin:"$PATH"\n'
function run(id: string, network: object, age = 0) {
  put('network.json', JSON.stringify(network))
  ssh(environment + "ucode -e 'import {writefile} from \"fs\"; writefile(\"" + root + '/cache/control-' + id + '.json\",sprintf(\"%J\",{id:\"' + id + '\",device:\"/dev/ttyUSB2\",profile_key:\"' + profileFingerprint() + '\",interface:\"wwan\",kind:\"data\",target:true,status:\"pending\",started:time()-' + age + '}));' + "'\n" + root + '/control --run ' + id + '\ncat ' + root + '/cache/control-' + id + '.json')
  return JSON.parse(ssh('cat ' + root + '/cache/control-' + id + '.json'))
}
const connected = run('1-1', { up: false, pending: false })
assert.equal(connected.status, 'ok')
assert.equal(connected.data.active, true)
assert.ok(connected.finished - connected.started < 5, 'must finish before child IP addresses exist')
const waiting = run('1-2', { up: false, pending: true, reject: true }, 58)
assert.equal(waiting.status, 'deferred', 'pending without parent up is not confirmed online')
const existing = run('1-3', { up: true, pending: true })
assert.equal(existing.status, 'ok')
assert.equal(JSON.parse(ssh('cat ' + root + '/network.json')).submitted, undefined, 'already-online parent does not redial')
console.log(JSON.stringify({ passed: 3, liveNetworkChanged: false, root }))
