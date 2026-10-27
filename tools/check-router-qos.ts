import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { qosHelper } from '../openwrt/qos.ts'
import { moduleQosCollector } from '../openwrt/module-qos.ts'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'

const options = ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts']
const host = process.env.CPE_ROUTER || 'root@192.168.2.248'
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const ssh = (command: string, input?: string) => execFileSync('ssh',[...options,host,command],{input,encoding:'utf8',timeout:25000,windowsHide:true}).trim()
const root = '/tmp/cpe-qos-check-' + Date.now()
ssh('umask 077; mkdir -p ' + root + '/cache ' + root + '/profiles')
const put = (path: string, content: string) => ssh('cat > ' + root + '/' + path, content)
put('qos',qosHelper)
put('collector.pl',moduleQosCollector)
const config = JSON.parse(ssh('cat /etc/cpe-status.json'))
put('config.json',JSON.stringify({...config,moduleQos:true}))
const content=JSON.stringify(rm500qProfile)
const key='2c7c0800:' + createHash('sha256').update(content).digest('hex')
put('profiles/2c7c0800.conf',content)
const serial=ssh('sh -s', 'path=$(readlink -f /sys/class/tty/' + config.device.slice(5) + '/device)\nwhile [ "$path" != / ]; do\n if [ -f "$path/idVendor" ]; then cat "$path/serial"; break; fi\n path=$(dirname "$path")\ndone\n')
assert.match(serial,/^[a-zA-Z0-9_.:-]{1,64}$/)
const state={profile_key:key,serial,boot_id:'test-boot'}
const sample={...state,iccid:'sim-a',apn:ssh('uci -q get network.wwan.apn'),data:{qci:9,dl_speed:4294000,ul_speed:4294000},sampled_at:1234}
const reset=()=>{put('cache/qos-state.json',JSON.stringify(state));put('cache/qos.json',JSON.stringify(sample));put('cache/sim-identity.json',JSON.stringify({profile_key:key,iccid:'sim-a'}))}
const run=()=>JSON.parse(ssh('CPE_STATUS_CACHE=' + root + '/cache CPE_STATUS_CONFIG=' + root + '/config.json CPE_STATUS_MODEM_DIRECTORY=' + root + '/profiles /usr/bin/ucode ' + root + '/qos read'))
ssh('ucode -c -o ' + root + '/qos.ucb ' + root + '/qos')
reset()
assert.deepEqual(run().data,sample.data)
put('cache/qos-state.json',JSON.stringify({...state,boot_id:'new-boot'}))
assert.equal(run().data.qci,null)
reset(); put('cache/sim-identity.json',JSON.stringify({profile_key:key,iccid:'sim-b'}))
assert.equal(run().data.qci,null)
reset(); put('cache/qos.json',JSON.stringify({...sample,apn:'not-current-apn'}))
assert.equal(run().data.qci,null)
reset(); put('config.json',JSON.stringify({...config,moduleQos:false}))
assert.equal(run().status,'unsupported')
put('config.json',JSON.stringify({...config,moduleQos:true}))
const disabled=structuredClone(rm500qProfile); delete disabled.diagQos
put('profiles/2c7c0800.conf',JSON.stringify(disabled))
assert.equal(run().status,'unsupported')
// Exercise readiness and arming against private fixtures, never the live worker.
put('profiles/2c7c0800.conf',content)
put('qos-mocked',qosHelper.replace(/^function remote\(id, cmd, seconds\).*$/m,
  "function remote(id, cmd, seconds) { return readfile(directory + '/remote-status.json') || ''; }"))
const invoke=(mode:string)=>JSON.parse(ssh('CPE_STATUS_CACHE=' + root + '/cache CPE_STATUS_CONFIG=' + root + '/config.json CPE_STATUS_MODEM_DIRECTORY=' + root + '/profiles /usr/bin/ucode ' + root + '/qos-mocked ' + mode))
const fixture=(name:string)=>JSON.parse(ssh('cat ' + root + '/cache/' + name))
reset()
invoke('arm')
const request=fixture('qos-request.json')
invoke('arm')
assert.equal(fixture('qos-request.json').id,request.id,'duplicate preparation reuses pending request')
assert.equal(invoke('wait').status,'deferred','old cached QoS must not bypass a pending listener request')
const live={...state,status:'collecting',worker_pid:1,request_id:request.id,run_id:'new-run'}
put('cache/qos-state.json',JSON.stringify(live))
put('cache/remote-status.json',JSON.stringify({boot_id:state.boot_id,run_id:'old-run',status:'listening'}))
assert.equal(invoke('wait').status,'deferred','old listener status is not readiness for this run')
put('cache/remote-status.json',JSON.stringify({boot_id:state.boot_id,run_id:live.run_id,status:'listening'}))
assert.equal(invoke('prepare').status,'ok')
assert.equal(fixture('qos-request.json').id,request.id,'reuse active listener without queuing another capture')
put('cache/qos-state.json',JSON.stringify({...state,status:'no-data',request_id:request.id}))
invoke('arm')
assert.notEqual(fixture('qos-request.json').id,request.id,'natural redial retries a previous no-data capture')
const mockBoot='11111111-2222-3333-4444-555555555555'
put('qos-tick-mocked',qosHelper
  .replace(/^function bounded\(cmd, seconds\) \{[\s\S]*?^\}/m,
    "function bounded(cmd, seconds) { if (index(cmd, '/usr/bin/adb ') == 0) return 'CPE_QOS_PUSHED'; return command(cmd); }")
  .replace(/^function remote\(id, cmd, seconds\).*$/m, `function remote(id, cmd, seconds) {
    if (cmd == 'cat /proc/sys/kernel/random/boot_id') return stat(directory+'/adb-offline') ? '' : '${mockBoot}';
    if (cmd == 'cat /tmp/cpe-status-qos/result.json') {
      let current=readJSON(statePath);
      return sprintf('%J',{schema_version:1,boot_id:'${mockBoot}',run_id:stat(directory+'/accept-run') ? current.run_id : 'old-run',sessions:[{kind:'data',apn:${JSON.stringify(sample.apn)},qci:9,dl_speed:4294000,ul_speed:4294000}]});
    }
    return '';
  }`))
const tick=()=>ssh('CPE_STATUS_CACHE=' + root + '/cache CPE_STATUS_CONFIG=' + root + '/config.json CPE_STATUS_MODEM_DIRECTORY=' + root + '/profiles /usr/bin/ucode ' + root + '/qos-tick-mocked tick')
reset()
put('cache/qos-state.json',JSON.stringify({...state,boot_id:mockBoot,status:'complete',request_id:fixture('qos-request.json').id,checked:0}))
put('cache/qos.json',JSON.stringify({...sample,boot_id:mockBoot}))
put('cache/adb-offline','yes'); tick()
assert.equal(run().data.qci,9,'temporary ADB outage must not clear cached QoS')
assert.equal(fixture('qos-state.json').adb_available,false)
ssh('rm ' + root + '/cache/adb-offline')
put('cache/qos-state.json',JSON.stringify({...fixture('qos-state.json'),checked:0}))
tick()
assert.equal(fixture('qos-state.json').adb_available,true)
assert.equal(fixture('qos.json').sampled_at,1234,'ADB recovery must not re-date or recollect a valid bearer cache')
reset()
put('cache/qos-state.json',JSON.stringify({...state,boot_id:mockBoot}))
put('cache/qos.json',JSON.stringify({...sample,boot_id:mockBoot}))
tick()
assert.equal(fixture('qos-state.json').status,'no-data')
assert.equal(fixture('qos.json').sampled_at,1234,'stale module result cannot be re-dated as fresh')
invoke('arm'); put('cache/accept-run','yes'); tick()
assert.equal(fixture('qos-state.json').status,'complete')
assert.deepEqual(fixture('qos.json').data,sample.data)
assert.ok(fixture('qos.json').sampled_at>1234)
const adb=(cmd: string)=>ssh('adb -s ' + quote(serial) + ' shell ' + quote(cmd))
ssh('adb -s ' + quote(serial) + ' push ' + root + '/collector.pl /tmp/cpe-status-qos-replay.pl')
ssh('adb -s ' + quote(serial) + ' push /tmp/cpe-qos-replay.hdlc /tmp/cpe-status-qos-replay.hdlc')
let replay
try { replay=JSON.parse(adb('perl /tmp/cpe-status-qos-replay.pl --decode /tmp/cpe-status-qos-replay.hdlc')) }
finally { adb('rm -f /tmp/cpe-status-qos-replay.pl /tmp/cpe-status-qos-replay.hdlc') }
assert.equal(replay.invalid_crc,0)
assert.equal(replay.sessions.length,1)
assert.equal(replay.sessions[0].qci,9)
assert.equal(replay.sessions[0].dl_speed,4294000)
assert.equal(replay.sessions[0].ul_speed,4294000)
const summary={passed:16,root,serial,checks:['ucode compilation','cached QCI/AMBR','reject old boot','reject different SIM','reject different APN','disabled/unavailable capability','pending request deduplication','cached result cannot skip pending listener','reject stale listener run','reuse ready listener','rearm after no-data','keep cache during ADB outage','reuse cache after ADB recovery','reject stale capture result','accept current capture result','module raw NAS replay']}
mkdirSync('build/router-audit',{recursive:true})
writeFileSync('build/router-audit/qos-check.json',JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary))
