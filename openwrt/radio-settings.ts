import { statusRuntime } from './status-collector.ts'
import { networkModes } from '../shared/radio-settings.ts'

export const radioSettingsRuntime = String.raw`
const allowedModes = __MODES__;
function radioAt(cmd) { return bounded('sms_tool -d ' + port + ' at ' + "'" + cmd + "'", 5); }
function requireRm500q() { return requireProfile(); }
function atError(raw) { return match(raw, /(^|\n)\s*(ERROR|\+CME ERROR:[^\r\n]*)/)?.[2] || ''; }
function modeReply(raw) {
  let mode = profileRow('mode', raw).mode;
  if (!mode || atError(raw)) die('无法确认模块网络模式：' + (atError(raw) || trim(raw)));
  return uc(mode);
}
function parseLock(raw, rat) {
  let operation = rat == 'lte' ? 'lteCellLock' : 'nrCellLock';
  if (!profileHas(operation)) return { ...profileUnsupported(operation), cells: [], raw: '' };
  let result = { status: 'error', cells: [], raw };
  try {
    if (atError(raw)) die(atError(raw));
    let rows = profileParse(rat == 'lte' ? 'lteCellLock' : 'nrCellLock', raw);
    if (length(rows) == 1 && rows[0].count === 0) result.count = 0;
    else {
      for (let row in rows) {
        if (row.rat != rat || row.arfcn == null || row.pci == null) die('锁定回读缺少小区参数');
        push(result.cells, row);
      }
      result.count = length(result.cells);
    }
    result.status = 'ok';
  } catch(e) { result.message = '' + e; }
  return result;
}
function readCellLocks() {
  let result = { device: port, lte: parseLock(profileHas('lteCellLock') ? radioAt(profileCommand('lteCellLock')) : '', 'lte'), nr: parseLock(profileHas('nrCellLock') ? radioAt(profileCommand('nrCellLock')) : '', 'nr'), sampled_at: time() };
  let previous = readJSON(directory + '/cell-locks.json');
  for (let rat in ['lte', 'nr']) if (result[rat].status == 'error' && previous?.device == port) {
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
if (profile && !profileHas('lteCellLock') && !profileHas('nrCellLock')) { reply(profileUnsupported('lteCellLock')); exit(0); }
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
let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock', acquired = mkdir(lock, 0700);
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
