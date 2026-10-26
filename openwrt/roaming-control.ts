import { statusRuntime } from './status-collector.ts'

// Separate executable: snapshot readers cannot invoke writes through parameters.
// Both executables own the same AT lock; only 1/255 can reach the modem.
export const roamingControl = statusRuntime + String.raw`
function reply(value) { print(sprintf('%J\n', value)); }
if (length(ARGV) != 1 || (ARGV[0] != '1' && ARGV[0] != '255')) {
  reply({ status: 'error', message: 'Invalid roaming preference; expected 1 or 255' }); exit(0);
}
mkdir(directory, 0700);
let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock', deadline = time() + 10;
while (!mkdir(lock, 0700)) {
  let owner = +text(lock + '/pid'), info = stat(lock);
  if ((!owner || !stat('/proc/' + owner)) && info && time() - info.mtime >= 2) { unlink(lock + '/pid'); rmdir(lock); continue; }
  if (time() >= deadline) { reply({ status: 'error', message: 'Modem 忙，漫游设置尚未提交，请稍后重试', submitted: false }); exit(0); }
  command('sleep 1');
}
writefile(lock + '/pid', '' + pid);
let submitted = false;
try {
  let target = +ARGV[0];
  requireProfile();
  let query = 'sms_tool -d ' + port + ' at ' + profileQuote(profileCommand('roamingPreference'));
  let raw = bounded(query, 5), before = profileRow('roamingPreference', raw).roam_pref;
  if (before == null) die('无法读取模块漫游偏好，未提交设置');
  if (before != target) {
    submitted = true;
    bounded('sms_tool -d ' + port + ' at ' + profileQuote(profileCommand('roamingSet', { preference: '' + target })), 5);
  }
  raw = bounded(query, 5);
  let confirmed = profileRow('roamingPreference', raw).roam_pref;
  if (confirmed != target) die('模块尚未确认漫游偏好，请稍后检查状态');
  let snapshot = readJSON(directory + '/snapshot.json'), sampled = time();
  if (snapshot && snapshot.device == port) {
    snapshot.raw.roaming = raw; snapshot.sampled.roaming = sampled;
    if (snapshot.warnings) delete snapshot.warnings.roaming;
    if (snapshot.attempted) delete snapshot.attempted.roaming;
    save(directory + '/snapshot.json', snapshot);
  }
  reply({ status: 'ok', message: '漫游偏好已确认并保存', data: { roam_pref: target, roaming_allowed: target == 255, policy_scope: 'registration' }, raw, sampled_at: sampled });
} catch(e) {
  // Never replay an ambiguous write. The next ordinary query can reconcile it.
  let snapshot = readJSON(directory + '/snapshot.json');
  if (submitted && snapshot && snapshot.device == port) {
    snapshot.sampled.roaming = 0;
    if (snapshot.attempted) delete snapshot.attempted.roaming;
    save(directory + '/snapshot.json', snapshot);
  }
  reply({ status: 'error', message: '' + e, submitted });
}
unlink(lock + '/pid'); rmdir(lock);
`
