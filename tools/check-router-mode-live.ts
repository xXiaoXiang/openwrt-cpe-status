import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { statusRuntime } from '../openwrt/status-collector.ts'
import { radioSettingsRuntime } from '../openwrt/radio-settings.ts'
import { modemControl, modemControlResult } from '../openwrt/modem-control.ts'

// Explicitly authorized live test: temporary RAT changes, data reconnect and RF
// off/on. Capture original state first and restore it through a shell EXIT trap.
const root = '/tmp/cpe-mode-live-' + process.pid
const probe = statusRuntime + radioSettingsRuntime + String.raw`
let lock=directory+'/lock', end=time()+20, held=false;
while(time()<end) { if(mkdir(lock,0700)) {held=true;break;} command('sleep 1'); }
if(!held) die('Modem lock busy');
writefile(lock+'/pid',''+pid);
let error=null;
try {
  let action=ARGV[0], original=readJSON(getenv('CPE_MODE_LIVE_DIR')+'/original.json');
  if(action=='restore-config') {
    let value=original?.qmi_modes || '', name='network.'+iface+'.modes';
    if(value && !match(value,/^[a-z0-9,]+$/)) die('Invalid original QMI modes');
    let current=trim(bounded('uci -q get '+name,3));
    if(current!=value) {
      let cmd=value?"uci set '"+name+'='+value+"'":"uci -q delete "+name;
      if(!match(bounded(cmd+'; uci commit network && echo CPE_CONFIG_RESTORED',5),/CPE_CONFIG_RESTORED/)) die('Cannot restore original UCI mode');
      unlink(directory+'/qmi-mode-pending.json');
      if(original.up) bounded('ifup '+iface,5);
    }
  }
  if(action=='set' || action=='restore') {
    let target=action=='restore'?original?.mode:ARGV[1];
    if(index(allowedModes,target)<0) die('Invalid mode');
    let before=modeReply(radioAt('AT+QNWPREFCFG="mode_pref"'));
    if(before!=target) {
      let raw=radioAt('AT+QNWPREFCFG="mode_pref",'+target);
      if(atError(raw)) die(atError(raw));
    }
  }
  let mode=modeReply(radioAt('AT+QNWPREFCFG="mode_pref"'));
  let radio=match(radioAt('AT+CFUN?'),/\+CFUN:\s*([0-9]+)/)?.[1];
  let dump=json(bounded('ubus -S call network.interface dump',3)), net=null, children=[];
  for(let row in dump.interface) {
    if(row.interface==iface) net=row;
    if(row.interface==iface+'_4'||row.interface==iface+'_6') push(children,{interface:row.interface,up:row.up,ipv4:row['ipv4-address']});
  }
  let result={time:time(),mode,radio:+radio,up:net?.up,pending:net?.pending,protocol:net?.proto,device:net?.l3_device,children};
  if(action=='baseline') {
    if(+radio!=1) die('Live test requires RF already on');
    result.save_ctrl=radioAt('AT+QNWLOCK="save_ctrl"');
    result.lte_lock=radioAt('AT+QNWLOCK="common/4g"');
    result.nr_lock=radioAt('AT+QNWLOCK="common/5g"');
    result.qmi_modes=trim(bounded('uci -q get network.'+iface+'.modes',3));
    save(getenv('CPE_MODE_LIVE_DIR')+'/original.json',result);
  }
  print(sprintf('%J\n',result));
} catch(e) {error=''+e;}
unlink(lock+'/pid');rmdir(lock);
if(error) die(error);
`
const script = [
  'set -eu', 'umask 077', `mkdir ${root}`, `export CPE_MODE_LIVE_DIR=${root}`, `export CPE_MODE_ISOLATE=${process.argv.includes('--isolate-qmi') ? 1 : 0}`,
  ...Object.entries({ probe, control: modemControl, result: modemControlResult }).flatMap(([file, content], i) => [`cat >${root}/${file} <<'CPE_MODE_FILE_${i}'`, content, `CPE_MODE_FILE_${i}`, `chmod 700 ${root}/${file}`]),
  `export CPE_MODE_CANDIDATE=${process.argv.includes('--candidate') ? 1 : 0}`,
  process.argv.includes('--candidate') ? `export CPE_STATUS_CONTROL_SCRIPT=${root}/control CPE_MODE_RESULT_SCRIPT=${root}/result` : 'export CPE_STATUS_CONTROL_SCRIPT=/usr/libexec/cpe-status-control CPE_MODE_RESULT_SCRIPT=/usr/libexec/cpe-status-control-result',
  String.raw`
runjob() {
  echo "JOB $1 $2"
  "$CPE_STATUS_CONTROL_SCRIPT" "$1" "$2" >"$CPE_MODE_LIVE_DIR/start.json"
  job=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_MODE_LIVE_DIR")+"/start.json")).job_id||"");')
  test -n "$job" || { cat "$CPE_MODE_LIVE_DIR/start.json"; return 1; }
  count=0
  while test "$count" -lt 34; do
    "$CPE_MODE_RESULT_SCRIPT" "$job" >"$CPE_MODE_LIVE_DIR/result.json"
    status=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_MODE_LIVE_DIR")+"/result.json")).status);')
    if test "$status" != pending; then
      ucode -e 'import {readfile} from "fs"; let job=json(readfile(getenv("CPE_MODE_LIVE_DIR")+"/result.json")); print(sprintf("%J\n",{status:job.status,message:job.message,data:job.data}));'
      test "$status" = ok; return
    fi
    sleep 2; count=$((count+1))
  done
  return 1
}
settle() {
  i=0
  while test "$i" -lt 12; do
    "$CPE_MODE_LIVE_DIR/probe" inspect
    if ping -I wwan0 -c 1 -W 2 1.1.1.1; then return 0; fi
    sleep 5; i=$((i+1))
  done
  echo 'DATA_STILL_PENDING'; return 0
}
echo '>>> baseline'
"$CPE_MODE_LIVE_DIR/probe" baseline
original_up=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_MODE_LIVE_DIR")+"/original.json")).up?1:0);')
cleanup() {
  trap - EXIT HUP INT TERM
  echo '>>> restoring-original-state'
  runjob airplane 0 || true
  "$CPE_MODE_LIVE_DIR/probe" restore-config
  runjob data "$original_up" || true
  "$CPE_MODE_LIVE_DIR/probe" restore
  if test "$original_up" = 1; then settle; fi
  echo '>>> restored'
  "$CPE_MODE_LIVE_DIR/probe" inspect
}
trap cleanup EXIT HUP INT TERM
if test "$CPE_MODE_ISOLATE" = 1; then
  runjob data 0
  device=$(uci -q get network.wwan.device)
  case "$device" in /dev/cdc-wdm[0-9]*) ;; *) echo 'Unsupported QMI device'; exit 1 ;; esac
  for step in online register sync; do
    echo ">>> isolated-$step-before"
    "$CPE_MODE_LIVE_DIR/probe" set LTE:NR5G
    case "$step" in
      online) uqmi -d "$device" -t 3000 --set-device-operating-mode online ;;
      register) uqmi -d "$device" -t 5000 --network-register ;;
      sync) uqmi -d "$device" -t 3000 --sync ;;
    esac
    echo ">>> isolated-$step-after"
    "$CPE_MODE_LIVE_DIR/probe" inspect
  done
  exit 0
fi
echo '>>> before-data-cycle'
if test "$CPE_MODE_CANDIDATE" = 1; then runjob mode LTE:NR5G; else "$CPE_MODE_LIVE_DIR/probe" set LTE:NR5G; fi
runjob data 0
echo '>>> after-data-off'
"$CPE_MODE_LIVE_DIR/probe" inspect
runjob data 1 || true
echo '>>> after-data-on'
settle
echo '>>> before-flight-cycle'
if test "$CPE_MODE_CANDIDATE" = 1; then runjob mode LTE:NR5G; else "$CPE_MODE_LIVE_DIR/probe" set LTE:NR5G; fi
runjob airplane 1
echo '>>> after-flight-on'
"$CPE_MODE_LIVE_DIR/probe" inspect
runjob airplane 0
echo '>>> after-flight-off'
settle
`,
].join('\n')
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let output = ''
child.stdout.on('data', part => { output += part; process.stdout.write(part) })
child.stderr.on('data', part => { output += part; process.stderr.write(part) })
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/' + (process.argv.includes('--candidate') ? 'mode-persistence-fixed-live.txt' : process.argv.includes('--isolate-qmi') ? 'mode-qmi-isolation-live.txt' : 'mode-persistence-live.txt'), output)
if (code !== 0) process.exitCode = 1
