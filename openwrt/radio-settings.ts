import { statusRuntime } from './status-collector.ts'
import { networkModes } from '../shared/radio-settings.ts'

export const radioSettingsRuntime = String.raw`
const allowedModes = __MODES__;
function radioAt(cmd) { return bounded('sms_tool -d ' + port + ' at ' + "'" + cmd + "'", 5); }
// QNWLOCK replies on R13 can be delayed/truncated by sms_tool; use the same
// terminal-aware reader as the AT console, still under the shared queue lock.
function cellLockAt(name) {
  return bounded('CPE_OPERATOR_COMMAND=' + profileQuote(profileCommand(name)) + ' gcom -d ' + port + ' -s /usr/libexec/cpe-status/operator-at 2>&1', 5);
}
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
  let result = { device: port, lte: parseLock(profileHas('lteCellLock') ? cellLockAt('lteCellLock') : '', 'lte'), nr: parseLock(profileHas('nrCellLock') ? cellLockAt('nrCellLock') : '', 'nr'), sampled_at: time() };
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
const self = getenv('CPE_STATUS_CELL_SCRIPT') || '/usr/libexec/cpe-status/cell-locks';
if (!match(self, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid cell read executable');
if (length(ARGV) > 2 || (length(ARGV) && index(['refresh','--refresh'],ARGV[0]) < 0) || (length(ARGV) == 2 && ARGV[0] != '--refresh')) die('Invalid cell read arguments');
let cached = readJSON(directory + '/cell-locks.json');
if (cached && cached.device != port) cached = null;
let fresh = ARGV[0] != 'refresh' && cached && time() - cached.sampled_at < cacheSeconds.cellLocks
  && !length(filter(['lte', 'nr'], rat => cached[rat]?.status == 'error'));
if (ARGV[0] != '--refresh') {
  let job = !fresh ? queueRead('cell-locks', self) : readJob('cell-locks');
  if (cached) { cached.stale = !fresh; reply({ status: job?.status == 'error' && !fresh ? 'error' : 'ok', data: cached, message: job?.message, ...readProgress(job) }); }
  else reply({ status: job?.status == 'error' ? 'error' : 'deferred', message: job?.message || '正在读取小区锁定状态', ...readProgress(job) });
  exit(0);
}
let job = beginRead('cell-locks', ARGV[1]);
if (!job) exit(0);
try {
  requireRm500q();
  let result = readCellLocks(), failed = filter(['lte', 'nr'], rat => result[rat].status == 'error');
  finishRead(job, length(failed) ? join('; ', map(failed, rat => rat + ': ' + result[rat].message)) : null);
} catch(e) { finishRead(job, '' + e); }
`
