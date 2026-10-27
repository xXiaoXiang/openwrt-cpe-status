import { statusRuntime } from './status-collector.ts'

export const apnRuntime = String.raw`
const apnOverridePath = getenv('CPE_STATUS_APN_OVERRIDES') || '/etc/cpe-status/apn-overrides.json';
function apnQuote(value) { return "'" + replace(value, /'/g, "'\\''") + "'"; }
function apnUci(key) { return trim(bounded('uci -q get network.wwan.' + key, 3)); }
function apnValidate(value) {
  if (type(value) != 'object' || type(value.apn) != 'string' || length(value.apn) > 100 || !match(value.apn, /^[A-Za-z0-9][A-Za-z0-9.-]*$/)) die('APN 名称格式无效');
  if (index(['ipv4','ipv6','ipv4v6'], value.pdptype) < 0 || index(['none','pap','chap','both'], value.auth) < 0) die('IP 协议或认证方式无效');
  for (let key in ['username','password']) if (type(value[key]) != 'string' || length(value[key]) > 128 || match(value[key], /[[:cntrl:]]/)) die('用户名或密码格式无效');
  return { apn: value.apn, pdptype: value.pdptype, auth: value.auth, username: value.username, password: value.password };
}
function apnSettings() {
  if (iface != 'wwan' || index(['qmi','mbim'], apnUci('proto')) < 0) die('APN 配置仅允许管理已有的 wwan QMI/MBIM 接口');
  let pdptype = apnUci('pdptype');
  return { apn: apnUci('apn'), pdptype: pdptype == 'ip' ? 'ipv4' : pdptype || 'ipv4', auth: apnUci('auth') || 'none', username: apnUci('username'), password: apnUci('password') };
}
function apnActive(raw) {
  let preferred = apnUci('apn'), contexts = [];
  let active = {};
  for (let row in profileParse('contextsActive', raw)) if (row.active) active[row.cid] = true;
  for (let row in profileParse('contexts', raw)) if (active[row.cid]) push(contexts, { active: true, active_apn: row.apn, active_protocol: row.protocol, sampled_at: time() });
  for (let context in contexts) if (lc(context.active_apn) == lc(preferred)) return context;
  if (length(contexts) == 1) return contexts[0];
  return { active: false, sampled_at: time() };
}
`

// Reads UCI and a cached PDP snapshot; explicit refresh schedules one locked AT
// query. Job polling never sends another modem query or restarts an interface.
export const apnReader = statusRuntime + apnRuntime + String.raw`
mkdir(directory, 0700);
const self = getenv('CPE_STATUS_APN_SCRIPT') || '/usr/libexec/cpe-status-apn';
if (!match(self, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid APN executable');
if (length(ARGV) > 1 || (length(ARGV) && index(['refresh','--refresh'], ARGV[0]) < 0)) die('Invalid APN read arguments');
let refresh = directory + '/apn-refresh';
try {
  let settings = apnSettings();
  if (profile && (!profileHas('contexts') || !profileHas('contextsActive'))) {
    print(sprintf('%J\n', { status: 'ok', data: { settings, active_supported: false, logs: [], sampled_at: time() }, refreshing: false })); exit(0);
  }
  if (ARGV[0] == '--refresh') {
    let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock';
    let acquired = mkdir(lock, 0700);
    if (!acquired) {
      let owner = +text(lock + '/pid'), info = stat(lock);
      if ((!owner || !stat('/proc/' + owner)) && info && time() - info.mtime >= 2) { unlink(lock + '/pid'); rmdir(lock); acquired = mkdir(lock, 0700); }
    }
    if (acquired) {
      writefile(lock + '/pid', '' + pid);
      try {
        let raw = bounded('sms_tool -d ' + port + ' at ' + apnQuote(profileBatch(['contexts','contextsActive'])), 5);
        if (length(profileParse('contextsActive', raw))) save(directory + '/apn-active.json', { device: port, ...apnActive(raw) });
      } catch(e) {}
      unlink(lock + '/pid'); rmdir(lock);
    }
    rmdir(refresh); exit(0);
  }
  let cached = readJSON(directory + '/apn-active.json');
  if (cached?.device != port) cached = null;
  let info = stat(refresh);
  if (info && time() - info.mtime > 15) rmdir(refresh);
  if ((ARGV[0] == 'refresh' || !cached) && mkdir(refresh, 0700)) system(self + ' --refresh </dev/null >/dev/null 2>&1 &');
  let job = readJSON(directory + '/apn-job.json');
  if (job?.device != port || job?.interface != iface) job = null;
  print(sprintf('%J\n', { status: 'ok', data: { settings, ...(cached || { active: false }), logs: job?.logs || [] }, refreshing: !!stat(refresh) }));
} catch(e) { print(sprintf('%J\n', { status: 'error', message: '' + e })); }
`
