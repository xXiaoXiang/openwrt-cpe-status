import { statusRuntime } from './status-collector.ts'

// All AT console and SMS operations share the collector/control serial lock.
export const messaging = statusRuntime + String.raw`
function quote(value) { return "'" + replace(value, /'/g, "'\\''") + "'"; }
function reply(value) { print(sprintf('%J\n', value)); }
function storagePath(value) {
  if (!match(value || '', /^\/[a-zA-Z0-9_.\/-]{1,220}$/) || match(value, /(^|\/)\.\.?($|\/)/) || match(value, /^\/(tmp|var|proc|sys|dev|www|rom)(\/|$)/)) die('请选择持久存储的绝对目录，不能使用临时或系统虚拟目录');
  return rtrim(value, '/');
}
function storeDirectory(path) {
  let parts = split(path, '/'), current = '';
  // A missing external mount must never redirect history onto router flash.
  if (match(path, /^\/(mnt|media)\//)) {
    let mounted = false;
    for (let line in split(text('/proc/mounts'), '\n')) {
      let mount = split(line, ' ')[1];
      if (mount && mount != '/' && (path == mount || index(path, mount + '/') == 0)) mounted = true;
    }
    if (!mounted) die('短信存储磁盘尚未挂载');
  }
  for (let part in parts) if (part) { current += '/' + part; if (!stat(current) && !mkdir(current, 0700)) die('不能创建短信目录'); }
  if (stat(path)?.type != 'directory') die('短信存储路径不是目录');
}
function history(path) { return readJSON(path + '/cpe-sms-history.json') || { next: 1, records: [], seen: [] }; }
function storeHistory(path, value) { save(path + '/cpe-sms-history.json', value); }
let action = ARGV[0] || 'list', storage = storagePath(config.smsStorage || '/etc/cpe-status/sms');
mkdir(directory, 0700);
if (action == 'config' && length(ARGV) == 1) { reply({ status: 'ok', data: { path: storage } }); exit(0); }
let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock';
if (!mkdir(lock, 0700)) {
  let owner = +text(lock + '/pid');
  if (owner && !stat('/proc/' + owner)) { unlink(lock + '/pid'); rmdir(lock); }
  if (!mkdir(lock, 0700)) {
    if (action == 'list') { reply({ status: 'ok', data: history(storage).records, deferred: true }); exit(0); }
    reply({ status: 'deferred', message: 'Modem 忙，请稍后重试' }); exit(0);
  }
}
writefile(lock + '/pid', '' + pid);
try {
  if (action == 'at') {
    let at = ARGV[1];
    // POSIX regcomp on the target limits {n,m} counts to 255.
    if (length(ARGV) != 2 || length(at || '') > 512 || !match(at || '', /^AT[ -~]*$/i)) die('只支持单行 AT 命令');
    let raw = bounded('CPE_OPERATOR_COMMAND=' + quote(at) + ' gcom -d ' + port + ' -s /usr/libexec/cpe-status-operator-at 2>&1', 20);
    // Arbitrary commands can alter anything; the next read reconciles caches.
    let readonly = false; for (let operation in values(profile?.commands || {})) if (operation.kind == 'read' && uc(operation.command) == uc(at)) readonly = true;
    if (!readonly) {
      let snapshot = readJSON(directory + '/snapshot.json');
      if (snapshot) { snapshot.sampled = {}; delete snapshot.attempted; save(directory + '/snapshot.json', snapshot); }
      for (let name in ['bands.json', 'cell-locks.json', 'operators.json']) unlink(directory + '/' + name);
    }
    if (!length(trim(raw))) die('AT 命令超时或没有返回');
    reply({ status: 'ok', data: raw });
  } else if (action == 'config') {
    let target = storagePath(ARGV[1]); storeDirectory(target);
    let previous = history(storage), merged = history(target);
    // Copy history before changing config; leave the old archive intact.
    for (let row in previous.records) {
      let exists = false;
      for (let candidate in merged.records) if (candidate.key == row.key) exists = true;
      if (!exists) { row.id = merged.next++; push(merged.records, row); }
    }
    for (let key in previous.seen) if (index(merged.seen, key) < 0) push(merged.seen, key);
    storeHistory(target, merged);
    config.smsStorage = target; save(configPath, config);
    reply({ status: 'ok', data: { path: target } });
  } else {
    storeDirectory(storage);
    let archive = history(storage);
    if (action == 'clear') {
      archive.records = []; storeHistory(storage, archive);
      reply({ status: 'ok', message: '本地历史已清空，模块短信保留' });
    } else if (action == 'send') {
      let number = ARGV[1], body = ARGV[2];
      if (!match(number || '', /^\+?[0-9]{3,20}$/) || !length(body || '') || length(body) > 280 || index(body, '\u001a') >= 0 || index(body, '\u001b') >= 0) die('无效的短信号码或内容');
      if (profile?.sms?.transport != 'sms-tool-3gpp') die('模块适配未启用标准短信传输');
      let result = bounded('sms_tool -d ' + port + ' send ' + quote(number) + ' ' + quote(body) + ' 2>&1', profile.sms.sendTimeout);
      if (!match(result, profileRegex(profile.sms.sentPattern)) || match(result, profileRegex(profile.sms.errorPattern))) die('短信未确认发送：' + result);
      let row = { id: archive.next++, key: 'sent-' + time() + '-' + pid, direction: 'outgoing', phone_number: number, content: body, timestamp: strftime('%Y-%m-%dT%H:%M:%SZ', time()), status: 'sent' };
      push(archive.records, row); storeHistory(storage, archive);
      reply({ status: 'ok', data: { db_id: row.id } });
    } else if (action == 'list' || action == 'sync') {
      let last = readJSON(directory + '/sms-sync.json'), changed = false, warnings = [];
      if (!stat(port) || readJSON(directory + '/sim-identity.json')?.present === false) {
        reply({ status: 'ok', data: archive.records }); unlink(lock + '/pid'); rmdir(lock); exit(0);
      }
      if (action == 'sync' || !last || time() - last.time >= 30) {
        let sim = readJSON(directory + '/sim-identity.json'), identity = sim?.iccid || sim?.imsi || 'unknown';
        for (let memory in profile?.sms?.transport == 'sms-tool-3gpp' ? profile.sms.memories : []) {
          let raw = bounded('sms_tool -d ' + port + ' -s ' + memory + ' -j -f ' + quote('%Y-%m-%dT%H:%M:%SZ') + ' recv 2>/dev/null', profile.sms.receiveTimeout), value = null;
          try { value = json(raw); } catch(e) {}
          if (!value || type(value.msg) != 'array') { push(warnings, memory + ' 短信读取暂未成功'); continue; }
          for (let msg in value.msg) {
            if (msg.error) { push(warnings, memory + ': ' + msg.error); continue; }
            let key = identity + ':' + memory + ':' + msg.index + ':' + msg.sender + ':' + msg.timestamp + ':' + msg.content;
            if (index(archive.seen, key) >= 0) continue;
            push(archive.seen, key);
            push(archive.records, { id: archive.next++, key, direction: 'incoming', phone_number: msg.sender, timestamp: msg.timestamp, content: msg.content, status: 'received', reference: msg.reference, part: msg.part, total: msg.total, sim: identity });
            changed = true;
          }
        }
        if (changed) storeHistory(storage, archive);
        // Failed/unsupported storage is also throttled. Browser refresh cannot
        // turn a failing SM read into an unbounded series of AT queries.
        save(directory + '/sms-sync.json', { time: time(), warnings });
      }
      reply({ status: 'ok', data: archive.records, warnings });
    } else die('无效的短信操作');
  }
} catch(e) { reply({ status: 'error', message: '' + e }); }
unlink(lock + '/pid'); rmdir(lock);
`
