import { statusRuntime } from './status-collector.ts'
import { radioSettingsRuntime } from './radio-settings.ts'
import { cellScanAt } from './cell-scan.ts'

// Command is supplied only by the validated, locked worker, never by the RPC caller.
export const operatorAt = cellScanAt.replace('send "AT+QSCAN=3,1^m"', 'let $c = $env("CPE_OPERATOR_COMMAND")\nsend $c\nsend "^m"')

export const operatorRuntime = String.raw`
function readOperator() {
  let raw = radioAt('AT+COPS?;+CEREG?;+C5GREG?;+QSPN');
  let cops = match(raw, /\+COPS:\s*([0-4])(,\s*([0-2]),\s*"([^"]*)"(,\s*([0-9]+))?)?/);
  if (!cops) die('无法读取运营商选择状态');
  let registration = null, registered = false;
  for (let line in split(raw, '\n')) {
    let reg = match(line, /\+C(5G|E)REG:\s*[0-5],\s*([0-9]+)/);
    if (reg) { if (registration == null) registration = +reg[2]; if (index([1,5], +reg[2]) >= 0) { registered = true; registration = +reg[2]; } }
  }
  let plmn = cops[3] == '2' && match(cops[4] || '', /^[0-9]{5,6}$/) ? cops[4] : '';
  let provider = match(raw, /\+QSPN:\s*"([^"]*)",\s*"([^"]*)",\s*"[^"]*",\s*[0-9]+,\s*"([0-9]{5,6})"/);
  if (!plmn && registered && provider) plmn = provider[3];
  let operator = cops[4] || '';
  if (provider && provider[3] == plmn && match(operator, /^[0-9]+$/)) operator = provider[1] || provider[2] || operator;
  let state = { mode: +cops[1], operator, plmn, registered, registration, sampled_at: time() };
  save(directory + '/operator-state.json', { device: port, state }); return state;
}
`

// File-only task polling; state refresh is explicit and uses the shared AT lock.
export const operatorReader = statusRuntime + radioSettingsRuntime + operatorRuntime + String.raw`
mkdir(directory, 0700);
const self = getenv('CPE_STATUS_OPERATOR_SCRIPT') || '/usr/libexec/cpe-status-operators';
if (!match(self, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid operator executable');
if (length(ARGV) > 1 || (length(ARGV) && index(['refresh','--refresh','current','state'],ARGV[0]) < 0)) die('Invalid operator read arguments');
let stateOnly = index(['current','state'],ARGV[0]) >= 0;
let refresh = directory + '/operator-refresh';
if (ARGV[0] == '--refresh') {
  let lock = directory + '/lock', acquired = mkdir(lock, 0700);
  if (!acquired) {
    let owner = +text(lock + '/pid'), info = stat(lock);
    if ((!owner || !stat('/proc/' + owner)) && info && time() - info.mtime >= 2) { unlink(lock + '/pid'); rmdir(lock); acquired = mkdir(lock, 0700); }
  }
  if (acquired) {
    writefile(lock + '/pid', '' + pid);
    try { readOperator(); unlink(directory + '/operator-read-error.json'); }
    catch(e) { save(directory + '/operator-read-error.json', { message: '' + e }); }
    unlink(lock + '/pid'); rmdir(lock);
  }
  rmdir(refresh); exit(0);
}
let cached = readJSON(directory + '/operator-state.json');
if (cached?.device != port) cached = null;
let pointer = readJSON(directory + '/operator-active.json');
let job = pointer && match(pointer.id || '', /^[0-9]+-[0-9]+$/) ? readJSON(directory + '/control-' + pointer.id + '.json') : null;
if (job?.device != port || job?.interface != iface || index(['operator','operator-scan'], job?.kind) < 0) job = null;
let busy = job?.status == 'pending' && time() - job.started < 245;
let info = stat(refresh);
if (info && time() - info.mtime > 30) rmdir(refresh);
if ((ARGV[0] == 'refresh' || ARGV[0] == 'current' || !cached) && !busy && (!cached || time() - cached.state.sampled_at >= 2) && mkdir(refresh,0700)) {
  system(self + ' --refresh </dev/null >' + directory + '/operator-reader.log 2>&1 &');
}
let scan = readJSON(directory + '/operator-scan.json');
if (scan?.device != port) scan = null;
let failure = readJSON(directory + '/operator-read-error.json');
if (stateOnly) {
  print(sprintf('%J\n', { status: failure && !cached ? 'error' : 'ok', state: cached?.state, refreshing: !!stat(refresh), busy: false, message: failure && !cached ? failure.message : '' })); exit(0);
}
print(sprintf('%J\n', { status: busy ? 'deferred' : job?.status == 'pending' ? 'error' : job?.status || (failure && !cached ? 'error' : 'ok'), busy,
  state: cached?.state, data: scan ? { raw: scan.raw, sampled_at: scan.sampled_at } : null, job_id: job?.id,
  message: busy ? '运营商操作进行中，可能需要1至3分钟，保留原结果' : job?.status == 'pending' ? '操作超时，请读取实际注册状态' : job?.message || failure?.message || '' }));
`
