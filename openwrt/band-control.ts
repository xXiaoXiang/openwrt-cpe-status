import { statusRuntime } from './status-collector.ts'

// Commands and semantics checked against obsy/modemband _quectel_common2.
// Discover supported bands from the modem instead of a static model template.
export const bandRuntime = String.raw`
const bandNames = {};
for (let key, entry in profile?.bandOperations || {}) if (profileHas(entry.read) && profileHas('bandCapabilities')) bandNames[key] = entry;
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
function parseBandReply(raw, capability) {
  let result = { lte: [], sa: [], nsa: [] }, seen = {};
  if (match(raw, /(^|\n)(ERROR|\+CME ERROR:)/)) die('模块拒绝频段查询');
  let records = [];
  if (capability) records = profileParse('bandCapabilities', raw);
  else for (let entry in values(bandNames)) for (let row in profileParse(entry.read, raw)) push(records, row);
  for (let row in records) if (row.rat in bandNames) {
    if (seen[row.rat]) die('频段查询返回重复结果');
    seen[row.rat] = true;
    result[row.rat] = bandList(row.bands);
  }
  for (let key in keys(bandNames)) if (!seen[key]) die('模块未返回完整频段');
  return result;
}
function bandAt(cmd) { return bounded('sms_tool -d ' + port + ' at ' + "'" + cmd + "'", 5); }
function readBands() {
  let capabilities = readJSON(directory + '/band-capabilities.json');
  if (!capabilities || capabilities.device != port || time() - capabilities.sampled_at >= cacheSeconds.bandCapabilities) {
    let raw = bandAt(profileBatch(['model', 'bandCapabilities']));
    let model = profileRow('model', raw).model; if (!match(model || '', profileRegex(profile.modelPattern))) die('模块型号与适配不匹配');
    capabilities = { device: port, model, supported: parseBandReply(raw, true), sampled_at: time() };
    save(directory + '/band-capabilities.json', capabilities);
  }
  let raw = bandAt(profileBatch(map(values(bandNames), entry => entry.read)));
  let unavailable = {};
  for (let key in ['lte', 'sa', 'nsa']) if (!bandNames[key]) unavailable[key] = '-';
  let result = { device: port, model: capabilities.model, supported: capabilities.supported, enabled: parseBandReply(raw), unavailable, sampled_at: time() };
  save(directory + '/bands.json', result);
  return result;
}
`

export const bandReader = statusRuntime + bandRuntime + String.raw`
function reply(value) { print(sprintf('%J\n', value)); }
mkdir(directory, 0700);
if (profile && !length(keys(bandNames))) { reply(profileUnsupported('bandCapabilities')); exit(0); }
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
let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock', acquired = mkdir(lock, 0700);
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
