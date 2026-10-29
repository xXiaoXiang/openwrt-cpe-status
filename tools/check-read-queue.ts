// Actual ucode concurrency checks with fake workers and an isolated AT lock.
// This tool never accesses the modem, real interface configuration or live cache.
import { execFileSync } from 'node:child_process'
import { readQueueRuntime } from '../openwrt/read-queue.ts'
import { modemActivityRuntime } from '../openwrt/modem-activity.ts'
import { bandReader } from '../openwrt/band-control.ts'
import { statusCollector } from '../openwrt/status-collector.ts'
import { cellLockReader } from '../openwrt/radio-settings.ts'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'
import { r13Snapshot } from '../tests/fixtures/rm500q-r13.ts'

const router = process.env.CPE_ROUTER || 'root@192.168.2.248'
const root = '/tmp/cpe-read-queue-check-' + Date.now()
const ssh = (script: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', router, 'sh -s'], { input: script + '\n', encoding: 'utf8', windowsHide: true, timeout: 30_000 })
const base = [
  '#!/usr/bin/ucode',
  "import { readfile, writefile, mkdir, rmdir, unlink, rename, stat, readlink } from 'fs';",
  'const directory = ' + JSON.stringify(root) + ", pid = +readlink('/proc/self'), port = '/dev/fake', cacheSeconds = { failure: 6 };",
  "let profileKey = 'fake-profile';",
  "function text(path) { return trim(readfile(path) || ''); }",
  'function readJSON(path) { try { return json(readfile(path)); } catch(e) { return null; } }',
  "function save(path, value) { let temp = path + '.' + pid; writefile(temp, sprintf('%J', value)); rename(temp, path); }",
  'function refreshProfile() { return true; }',
  modemActivityRuntime, readQueueRuntime,
].join('\n')
const files: Record<string, string> = {}
for (const key of ['bands', 'cell-locks', 'snapshot', 'apn', 'euicc-write']) files[key] = base + '\n' + [
  'const key = ' + JSON.stringify(key) + ';',
  "if (ARGV[0] != '--refresh') { print(sprintf('%J', queueRead(key, directory + '/' + key))); exit(0); }",
  'let job = beginRead(key, ARGV[1]);',
  'if (!job) exit(0);',
  'try {',
  "  let events = text(directory + '/events'); writefile(directory + '/events', events + (length(events) ? ',' : '') + key);",
  "  sleep(key == 'euicc-write' ? 1200 : key == 'bands' ? 1000 : 150);",
  "  if (key == 'apn') die('simulated read failure');",
  '  finishRead(job);',
  "} catch(e) { finishRead(job, '' + e); }",
].join('\n')
files['verify-pause'] = base + '\n' + String.raw`
function check(value,message) { if (!value) die(message); }
unlink(readPath('bands')); unlink(readPath('snapshot')); writefile(directory+'/events','');
mkdir(directory+'/lock',0700); writefile(directory+'/lock/pid',''+pid);
let held=queueRead('bands',directory+'/bands');
let download=queueRead('euicc-write',directory+'/euicc-write','download');
check(downloadActivity().active,'queued download did not pause reads');
let refused=queueRead('snapshot',directory+'/snapshot');
check(refused.status=='deferred' && refused.paused && !stat(readPath('snapshot')),'paused refresh enqueued another worker');
releaseReadLock(); sleep(350);
check(text(directory+'/events')=='euicc-write','download did not precede queued reads');
let until=readClock()+5;
while (readClock()<until && readJob('bands')?.status=='pending') sleep(100);
check(text(directory+'/events')=='euicc-write,bands' && readJob('bands')?.status=='ok','existing read did not resume once');
check(!downloadActivity().active && !stat(directory+'/lock'),'download completion leaked activity/lock');
print(sprintf('%J\n',{download_priority:true,no_refresh_backlog:true,queued_read_resumed:true}));
`
files.verify = base + '\n' + [
  'function check(value, message) { if (!value) die(message); }',
  'let ids = {};',
  "for (let i = 1; i <= 16; i++) { let reply = readJSON(directory + '/reply-' + i); check(reply?.id, 'missing job ID'); ids[reply.id] = true; }",
  "check(length(keys(ids)) == 1, 'duplicate jobs submitted');",
  "let running = readJSON(directory + '/running-reply'); check(running?.state == 'running' && ids[running.id], 'running task was not reused');",
  "let events = text(directory + '/events');",
  "check(events == 'bands,cell-locks,snapshot,apn', 'wrong order or duplicate execution: ' + events);",
  "for (let key in ['bands','cell-locks','snapshot']) check(readJob(key)?.status == 'ok', key + ' failed');",
  "check(readJob('apn')?.status == 'error', 'failure not retained');",
  "check(!stat(directory + '/lock'), 'AT lock leaked');",
  "save(readPath('operator'), { id: 'dead', device: port, profile_key: profileKey, status: 'pending', worker: 99999999, queued: readClock(), key: 'operator' });",
  "check(readJob('operator')?.status == 'error', 'dead worker not recovered');",
  "print(sprintf('%J', { requests: 16, executions: split(events, ','), dead_worker_recovered: true, lock_released: true }));",
].join('\n')
files['integration-bands'] = bandReader
files['integration-snapshot'] = statusCollector
files['integration-cell-locks'] = cellLockReader
files['modem.d/2c7c0800.conf'] = JSON.stringify(rm500qProfile)
files['config.json'] = JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan' })
files['mock-reply'] = Object.values(r13Snapshot.raw).join('\n') + '\n+QNWPREFCFG: "mode_pref",LTE:NR5G\n'
files['bin/sms_tool'] = [
  '#!/usr/bin/ucode',
  "import { readfile, writefile } from 'fs';",
  'const root = ' + JSON.stringify(root) + ', cmd = ARGV[3];',
  "writefile(root + '/commands', (readfile(root + '/commands') || '') + cmd + '\\n');",
  "if (index(cmd, 'ue_capability_band') >= 0) print('RM500Q-GL\\n+QNWPREFCFG: \"lte_band\",1:3:7\\n+QNWPREFCFG: \"nr5g_band\",78:79\\n+QNWPREFCFG: \"nsa_nr5g_band\",78:79\\n');",
  "else if (index(cmd, 'lte_band') >= 0) print('+QNWPREFCFG: \"lte_band\",3:7\\n+QNWPREFCFG: \"nr5g_band\",78\\n+QNWPREFCFG: \"nsa_nr5g_band\",78\\n');",
  "else { if (index(cmd, '+CPIN?') >= 0) { writefile(root + '/status-started', 'yes'); sleep(600); } print(readfile(root + '/mock-reply')); }",
].join('\n')
files['bin/gcom'] = "#!/bin/sh\nprintf '%s\\n' ERROR\n"
files['verify-integration'] = [
  '#!/usr/bin/ucode',
  "import { readfile } from 'fs';",
  'const root = ' + JSON.stringify(root) + ';',
  "function value(path) { return json(readfile(root + '/' + path)); }",
  'function check(value, message) { if (!value) die(message); }',
  "check(value('cold-snapshot').error, 'cold RPC waited for the modem');",
  "let commands = split(trim(readfile(root + '/commands')), '\\n');",
  "check(index(commands[0], '+CPIN?') >= 0 && index(commands[1], 'ue_capability_band') >= 0 && index(commands[2], 'lte_band') >= 0, 'snapshot did not yield between AT groups');",
  "check(length(filter(commands, cmd => index(cmd, 'ue_capability_band') >= 0)) == 1, 'duplicate capabilities AT');",
  "check(length(filter(commands, cmd => index(cmd, 'lte_band') >= 0 && index(cmd, 'ue_capability_band') < 0)) == 1, 'duplicate preferences AT');",
  'let ids = {};',
  "for (let i = 1; i <= 16; i++) { let r = value('band-reply-' + i); check(r.job_id, 'missing reader job ID'); ids[r.job_id] = true; }",
  "check(length(keys(ids)) == 1, 'reader submitted duplicate jobs');",
  "let snapshot = value('integration-cache/snapshot.json');",
  "check(length(keys(snapshot.sampled)) == 8 && !length(keys(snapshot.warnings || {})), 'snapshot did not resume remaining groups');",
  "let cell = value('integration-cache/read-cell-locks.json'), failed = value('failed-cells');",
  "check(cell.status == 'error' && failed.status == 'error' && failed.data.stale, 'invalid cell reply was cached as a fresh success');",
  "print(sprintf('%J', { cold_rpc_async: true, snapshot_yielded: true, coalesced_band_requests: 16, band_at_commands: 2, snapshot_resumed: true, invalid_reply_not_cached_as_success: true }));",
].join('\n')
const upload = Object.entries(files).map(([name, contents]) => "cat > '" + root + '/' + name + "' <<'CPE_QUEUE_FILE_EOF'\n" + contents + '\nCPE_QUEUE_FILE_EOF')
const script = [
  'set -eu', 'umask 077', "mkdir -p '" + root + "/bin' '" + root + "/modem.d' '" + root + "/integration-cache' '" + root + "/sys/class/tty/ttyUSB2/device'", ...upload,
  "chmod +x '" + root + "/bands' '" + root + "/cell-locks' '" + root + "/snapshot' '" + root + "/apn' '" + root + "/euicc-write'",
  "mkdir '" + root + "/lock'", "echo $$ > '" + root + "/lock/pid'",
  "'" + root + "/snapshot' > '" + root + "/initial-snapshot'",
  "for i in $(seq 1 16); do '" + root + "/bands' > '" + root + "/reply-'$i & done",
  'wait',
  "'" + root + "/cell-locks' > '" + root + "/initial-cells'",
  'sleep 1', "rm '" + root + "/lock/pid'", "rmdir '" + root + "/lock'",
  "ucode -e 'sleep(300)'", "'" + root + "/bands' > '" + root + "/running-reply'",
  'sleep 2', "'" + root + "/apn' > '" + root + "/initial-apn'", 'sleep 1',
  "ucode '" + root + "/verify'",
  "ucode '" + root + "/verify-pause'",
  "printf '2c7c' > '" + root + "/sys/class/tty/ttyUSB2/device/idVendor'",
  "printf '0800' > '" + root + "/sys/class/tty/ttyUSB2/device/idProduct'",
  "chmod +x '" + root + "/integration-bands' '" + root + "/integration-snapshot' '" + root + "/integration-cell-locks' '" + root + "/bin/sms_tool' '" + root + "/bin/gcom'",
  'export CPE_STATUS_CACHE=' + root + '/integration-cache CPE_STATUS_CONFIG=' + root + '/config.json CPE_STATUS_SYSFS=' + root + '/sys CPE_STATUS_MODEM_DIRECTORY=' + root + '/modem.d',
  'export CPE_STATUS_SCRIPT=' + root + '/integration-snapshot CPE_STATUS_BAND_SCRIPT=' + root + '/integration-bands CPE_STATUS_CELL_SCRIPT=' + root + '/integration-cell-locks',
  'export PATH=' + root + '/bin:"$PATH"',
  "'" + root + "/integration-snapshot' > '" + root + "/cold-snapshot'",
  "for i in $(seq 1 30); do test -f '" + root + "/status-started' && break; ucode -e 'sleep(100)'; done",
  "for i in $(seq 1 16); do '" + root + "/integration-bands' > '" + root + "/band-reply-'$i & done",
  'wait', 'sleep 2',
  "ucode -e 'let fs=require(\"fs\"), p=getenv(\"CPE_STATUS_CACHE\")+\"/snapshot.json\", s=json(fs.readfile(p)); s.host.time=time()-2; fs.writefile(p,sprintf(\"%J\",s));'",
  "'" + root + "/integration-snapshot' > '" + root + "/resuming-snapshot'",
  'sleep 2', "'" + root + "/integration-cell-locks' > '" + root + "/initial-cell-error'", 'sleep 1',
  "'" + root + "/integration-cell-locks' > '" + root + "/failed-cells'",
  "ucode '" + root + "/verify-integration'",
].join('\n')
try {
  console.log(ssh(script))
  if (!/^\/tmp\/cpe-read-queue-check-\d+$/.test(root)) throw new Error('Invalid fixture cleanup path')
  ssh("find '" + root + "' -type f -exec rm -f {} \\;\nfind '" + root + "' -depth -type d -exec rmdir {} \\;")
} catch (error) {
  console.error('Isolated test artifacts retained at ' + root)
  throw error
}
