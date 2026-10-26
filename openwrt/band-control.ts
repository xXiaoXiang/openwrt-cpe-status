import { statusRuntime } from './status-collector.ts'

// Commands and semantics checked against obsy/modemband _quectel_common2.
// Discover supported bands from the modem instead of a static model template.
export const bandRuntime = String.raw`
const bandNames = { lte: 'lte_band', sa: 'nr5g_band', nsa: 'nsa_nr5g_band' };
function bandList(value) {
  if (type(value) != 'string' || !match(value, /^[1-9][0-9]*(:[1-9][0-9]*)*$/) || length(value) > 640) die('Invalid band list');
  let bands = [];
  for (let item in split(value, ':')) {
    let number = +item;
    if (number > 1024 || index(bands, number) >= 0) die('Invalid or duplicate band');
    push(bands, number);
  }
  if (length(bands) > 128) die('Too many bands');
  return sort(bands, (a, b) => a - b);
}
function parseBandReply(raw) {
  let result = {};
  if (match(raw, /(^|\n)(ERROR|\+CME ERROR:)/)) die('模块拒绝频段查询');
  for (let line in split(raw, '\n')) {
    let found = match(trim(line), /^\+QNWPREFCFG:\s*"(lte_band|nr5g_band|nsa_nr5g_band)",\s*([0-9:]+)\s*$/);
    if (found) for (let key, name in bandNames) if (found[1] == name) {
      if (result[key]) die('频段查询返回重复结果');
      result[key] = bandList(found[2]);
    }
  }
  for (let key in keys(bandNames)) if (!result[key]) die('模块未返回完整的 LTE / SA / NSA 频段');
  return result;
}
function bandAt(cmd) { return bounded('sms_tool -d ' + port + ' at ' + "'" + cmd + "'", 5); }
function readBands() {
  let capabilities = readJSON(directory + '/band-capabilities.json');
  if (!capabilities || capabilities.device != port || time() - capabilities.sampled_at >= cacheSeconds.bandCapabilities) {
    let raw = bandAt('AT+CGMM;+QNWPREFCFG="ue_capability_band"');
    if (!match(raw, /(^|\n)RM500Q-GL\s*(\r?\n|$)/)) die('当前频段设置仅适配 RM500Q-GL');
    capabilities = { device: port, model: 'RM500Q-GL', supported: parseBandReply(raw), sampled_at: time() };
    save(directory + '/band-capabilities.json', capabilities);
  }
  let raw = bandAt('AT+QNWPREFCFG="lte_band";+QNWPREFCFG="nr5g_band";+QNWPREFCFG="nsa_nr5g_band"');
  let result = { device: port, model: capabilities.model, supported: capabilities.supported, enabled: parseBandReply(raw), sampled_at: time() };
  save(directory + '/bands.json', result);
  return result;
}
`

export const bandReader = statusRuntime + bandRuntime + String.raw`
function reply(value) { print(sprintf('%J\n', value)); }
mkdir(directory, 0700);
const bandScript = getenv('CPE_STATUS_BAND_SCRIPT') || '/usr/libexec/cpe-status-bands';
if (!match(bandScript, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid band executable');
if (length(ARGV) > 1 || (length(ARGV) && ARGV[0] != '--refresh')) die('Invalid band read arguments');
let cached = readJSON(directory + '/bands.json');
if (cached && cached.device != port) cached = null;
let fresh = cached && time() - cached.sampled_at < cacheSeconds.bands;
let refreshLock = directory + '/band-refresh-lock';
if (ARGV[0] != '--refresh') {
  if (!fresh) {
    let info = stat(refreshLock);
    if (info && time() - info.mtime > 20) rmdir(refreshLock);
    let failure = readJSON(directory + '/band-failure.json');
    if ((!failure || time() - failure.time >= cacheSeconds.failure) && mkdir(refreshLock, 0700)) {
      system(bandScript + ' --refresh </dev/null >' + directory + '/band-reader.log 2>&1 &');
    }
  }
  let failure = readJSON(directory + '/band-failure.json');
  if (cached) { cached.stale = !fresh; reply({ status: 'ok', data: cached, message: !fresh ? failure?.message : null }); }
  else reply({ status: failure ? 'error' : 'deferred', message: failure?.message || '正在读取模块频段，请稍候', retry_after_ms: 2000 });
  exit(0);
}
let lock = directory + '/lock', acquired = mkdir(lock, 0700);
if (!acquired) {
  let owner = +text(lock + '/pid'), info = stat(lock);
  if ((!owner || !stat('/proc/' + owner)) && info && time() - info.mtime >= 2) {
    unlink(lock + '/pid'); rmdir(lock); acquired = mkdir(lock, 0700);
  }
}
if (acquired) {
  writefile(lock + '/pid', '' + pid);
  try {
    cached = readJSON(directory + '/bands.json');
    if (!cached || cached.device != port || time() - cached.sampled_at >= cacheSeconds.bands) readBands();
    unlink(directory + '/band-failure.json');
  } catch(e) { save(directory + '/band-failure.json', { time: time(), message: '' + e }); }
  unlink(lock + '/pid'); rmdir(lock);
}
rmdir(refreshLock);
`
