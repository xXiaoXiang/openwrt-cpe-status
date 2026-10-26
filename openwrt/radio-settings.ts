import { statusRuntime } from './status-collector.ts'
import { networkModes } from '../shared/radio-settings.ts'

export const radioSettingsRuntime = String.raw`
const allowedModes = __MODES__;
function radioAt(cmd) { return bounded('sms_tool -d ' + port + ' at ' + "'" + cmd + "'", 5); }
function requireRm500q() {
  let snapshot = readJSON(directory + '/snapshot.json');
  if (snapshot?.device == port && time() - (snapshot.sampled.identity || 0) < cacheSeconds.identity && match(snapshot.raw.identity || '', /(^|\n)RM500Q-GL\s*(\r?\n|$)/)) return;
  if (!match(radioAt('AT+CGMM'), /(^|\n)RM500Q-GL\s*(\r?\n|$)/)) die('当前设置仅适配 RM500Q-GL');
}
function atError(raw) { return match(raw, /(^|\n)\s*(ERROR|\+CME ERROR:[^\r\n]*)/)?.[2] || ''; }
function modeReply(raw) {
  let found = match(raw, /\+QNWPREFCFG:\s*"mode_pref",\s*([A-Z0-9:]+)\s*(\r?\n|$)/i);
  if (!found || atError(raw)) die('无法确认模块网络模式：' + (atError(raw) || trim(raw)));
  return uc(found[1]);
}
function parseLock(raw, rat) {
  let result = { status: 'error', cells: [], raw }, name = rat == 'lte' ? 'common/4g' : 'common/5g';
  let found = null;
  for (let line in split(raw, '\n')) {
    let row = match(trim(line), /^\+QNWLOCK:\s*"(common\/[45]g)",\s*([0-9, ]+)$/);
    if (row && row[1] == name) { found = split(replace(row[2], ' ', ''), ','); break; }
  }
  if (!found || atError(raw)) { result.message = atError(raw) || '模块未返回可确认的锁定状态'; return result; }
  let nums = map(found, value => +value);
  if (rat == 'lte') {
    let count = nums[0];
    if (count > 10 || length(nums) != 1 + count * 2) { result.message = 'LTE锁定回读格式无效'; return result; }
    for (let i = 0; i < count; i++) {
      let arfcn = nums[1 + i * 2], pci = nums[2 + i * 2];
      if (arfcn > 262143 || pci > 503) { result.message = 'LTE锁定回读参数超出范围'; return result; }
      push(result.cells, { rat, arfcn, pci });
    }
    result.count = count;
  } else {
    // RM500Q R13 QNWLOCK=? confirms PCI,NR-ARFCN,SCS(kHz),Band; no count.
    if (nums[0] == 0 && (length(nums) == 1 || (length(nums) == 4 && nums[1] == 0))) result.count = 0;
    else if (length(nums) == 4 && nums[0] <= 1007 && nums[1] > 0 && nums[1] <= 3279165 && index([15,30,60,120,240], nums[2]) >= 0 && nums[3] > 0 && nums[3] <= 1024) {
      result.count = 1; push(result.cells, { rat, pci: nums[0], arfcn: nums[1], scs_khz: nums[2], band: nums[3] });
    } else { result.message = 'NR锁定回读格式无效'; return result; }
  }
  result.status = 'ok'; return result;
}
function readCellLocks() {
  let result = { device: port, lte: parseLock(radioAt('AT+QNWLOCK="common/4g"'), 'lte'), nr: parseLock(radioAt('AT+QNWLOCK="common/5g"'), 'nr'), sampled_at: time() };
  let previous = readJSON(directory + '/cell-locks.json');
  for (let rat in ['lte', 'nr']) if (result[rat].status != 'ok' && previous?.device == port) {
    result[rat].previous = previous[rat]?.status == 'ok' ? previous[rat] : previous[rat]?.previous;
    // Keep last success across repeated failed reads, but never confirm writes from it.
  }
  save(directory + '/cell-locks.json', result); return result;
}
function lockConfirmed(state, target) {
  let result = state[target.rat];
  if (result.status != 'ok') return false;
  if (target.action == 'unlock') return result.count == 0;
  if (result.count != 1) return false;
  let cell = result.cells[0];
  return cell.arfcn == target.arfcn && cell.pci == target.pci && (target.rat == 'lte' || (cell.band == target.band && cell.scs_khz == target.scs_khz));
}
`.replace('__MODES__', JSON.stringify(networkModes.map(mode => mode.value)))

export const cellLockReader = statusRuntime + radioSettingsRuntime + String.raw`
function reply(value) { print(sprintf('%J\n', value)); }
mkdir(directory, 0700);
const self = getenv('CPE_STATUS_CELL_SCRIPT') || '/usr/libexec/cpe-status-cell-locks';
if (!match(self, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid cell read executable');
if (length(ARGV) > 1 || (length(ARGV) && index(['refresh','--refresh'],ARGV[0]) < 0)) die('Invalid cell read arguments');
let cached = readJSON(directory + '/cell-locks.json');
if (cached && cached.device != port) cached = null;
let fresh = ARGV[0] != 'refresh' && cached && time() - cached.sampled_at < cacheSeconds.cellLocks;
let refresh = directory + '/cell-refresh-lock';
if (ARGV[0] != '--refresh') {
  if (!fresh) {
    let info = stat(refresh);
    if (info && time() - info.mtime > 20) rmdir(refresh);
    let failure = readJSON(directory + '/cell-failure.json');
    if ((!failure || time() - failure.time >= cacheSeconds.failure) && mkdir(refresh, 0700)) system(self + ' --refresh </dev/null >' + directory + '/cell-reader.log 2>&1 &');
  }
  if (cached) { cached.stale = !fresh; reply({ status: 'ok', data: cached }); }
  else reply({ status: 'deferred', message: '正在读取小区锁定状态', retry_after_ms: 2000 });
  exit(0);
}
let lock = directory + '/lock', acquired = mkdir(lock, 0700);
if (!acquired) {
  let owner = +text(lock + '/pid'), info = stat(lock);
  if ((!owner || !stat('/proc/' + owner)) && info && time() - info.mtime >= 2) { unlink(lock + '/pid'); rmdir(lock); acquired = mkdir(lock, 0700); }
}
if (acquired) {
  writefile(lock + '/pid', '' + pid);
  try { requireRm500q(); readCellLocks(); unlink(directory + '/cell-failure.json'); }
  catch(e) { save(directory + '/cell-failure.json', { time: time(), message: '' + e }); }
  unlink(lock + '/pid'); rmdir(lock);
}
rmdir(refresh);
`
