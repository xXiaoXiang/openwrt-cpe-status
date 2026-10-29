import { statusRuntime } from './status-collector.ts'
import { smsArchiveRuntime } from './sms-archive.ts'

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
` + smsArchiveRuntime + String.raw`
let action = ARGV[0] || 'list', storage = storagePath(config.smsStorage || '/etc/cpe-status/sms');
mkdir(directory, 0700);
let smsSupported = profileEnabled('sms') && profile?.sms?.transport == 'sms-tool-3gpp';
if (index(['send','sync','cleanup-start','cleanup'], action) >= 0 && !smsSupported) { reply(profileUnsupported('sms')); exit(0); }
if (action == 'config' && length(ARGV) == 1) { reply({ status: 'ok', data: { path: storage } }); exit(0); }
let cleanupFile = directory + '/sms-cleanup.json';
function cleanupState() {
  let job = readJSON(cleanupFile);
  if (!job || job.device != port || job.profile_key != profileKey) return {status:'ok',data:{deleted:0}};
  if (job.status == 'pending' && (time() - job.started > 300 || (!job.worker && time() - job.started > 15) || (job.worker && !stat('/proc/' + job.worker)))) return {status:'error',message:'短信清理任务已退出，请重新读取后重试'};
  return job;
}
if (action == 'cleanup-status') { reply(cleanupState()); exit(0); }
if (downloadActivity().active) {
  reply(action=='list' ? {status:'ok',data:history(storage).records,paused:true} : downloadDeferred()); exit(0);
}
if (action == 'sync' && manualReadPending()) { reply({ status: 'deferred', message: '手动读取排队中，稍后同步短信' }); exit(0); }
let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock';
if (action == 'cleanup') for (let i = 0; i < 100 && stat(lock); i++) sleep(100);
if (!mkdir(lock, 0700)) {
  let owner = +text(lock + '/pid');
  if (owner && !stat('/proc/' + owner)) { unlink(lock + '/pid'); rmdir(lock); }
  if (!mkdir(lock, 0700)) {
    if (action == 'list') { reply({ status: 'ok', data: history(storage).records, deferred: true }); exit(0); }
    let value = { status: action == 'cleanup' ? 'error' : 'deferred', message: 'Modem 忙，请稍后重试' };
    if (action == 'cleanup') save(cleanupFile, { ...cleanupState(), ...value });
    reply(value); exit(0);
  }
}
writefile(lock + '/pid', '' + pid);
try {
  if (action == 'at') {
    let at = ARGV[1];
    // POSIX regcomp on the target limits {n,m} counts to 255.
    if (length(ARGV) != 2 || length(at || '') > 512 || !match(at || '', /^AT[ -~]*$/i)) die('只支持单行 AT 命令');
    let raw = bounded('CPE_OPERATOR_COMMAND=' + quote(at) + ' gcom -d ' + port + ' -s /usr/libexec/cpe-status/operator-at 2>&1', 20);
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
      for (let candidate in merged.records) if (candidate.key == row.key) { exists = true; if (row.status == 'read') candidate.status = 'read'; }
      if (!exists) { row.id = merged.next++; push(merged.records, row); }
    }
    for (let key in previous.seen) if (index(merged.seen, key) < 0) push(merged.seen, key);
    storeHistory(target, merged);
    config.smsStorage = target; save(configPath, config);
    reply({ status: 'ok', data: { path: target } });
  } else if (action == 'cleanup-start') {
    if (!profileHas('smsStorageSelect') || !profileHas('smsDelete')) { reply(profileUnsupported('smsDelete')); }
    else {
      let job = cleanupState();
      if (job.status != 'pending') {
        let self = getenv('CPE_STATUS_MESSAGING_SCRIPT') || '/usr/libexec/cpe-status/messaging';
        if (!match(self, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid messaging executable');
        job = { status:'pending', id:time() + '-' + pid, started:time(), worker:null, device:port, profile_key:profileKey };
        save(cleanupFile, job);
        command('/usr/bin/setsid ' + quote(self) + ' cleanup ' + quote(job.id) + ' </dev/null >/dev/null 2>&1 &');
      }
      reply(job);
    }
  } else {
    storeDirectory(storage);
    let archive = history(storage);
    if (archive._dirty) storeHistory(storage, archive);
    if (action == 'clear') {
      archive.records = []; storeHistory(storage, archive);
      reply({ status: 'ok', message: '本地历史已清空，模块短信保留' });
    } else if (action == 'read') {
      let ids = json(ARGV[1] || '[]');
      if (type(ids) != 'array' || !length(ids) || length(ids) > 1000) die('无效短信 ID');
      for (let id in ids) if (type(id) != 'int' || id < 1) die('无效短信 ID');
      let changed = false;
      for (let row in archive.records) if (row.direction == 'incoming' && row.status == 'received' && index(ids, row.id) >= 0) { row.status = 'read'; changed = true; }
      if (changed) storeHistory(storage, archive);
      reply({status:'ok',data:archive.records});
    } else if (action == 'storage-check') {
      let probe = storage + '/.cpe-storage-check-' + pid;
      if (!writefile(probe, 'cpe-status')) die('短信目录不可写');
      unlink(probe);
      reply({status:'ok',data:{path:storage,records:length(archive.records),unread:length(filter(archive.records, row => row.direction == 'incoming' && row.status == 'received')),last_sync:readJSON(directory+'/sms-sync.json')?.time,warnings:readJSON(directory+'/sms-sync.json')?.warnings || []}});
    } else if (action == 'cleanup') {
      let job = cleanupState();
      if (job.status != 'pending' || job.id != ARGV[1]) die('无效短信清理任务');
      job.worker = pid; save(cleanupFile, job);
      if (!profileHas('smsStorageSelect') || !profileHas('smsDelete')) die('模块适配不支持逐条清理短信');
      let sim = readJSON(directory + '/sim-identity.json');
      if (!sim?.present || !sim.iccid || !stat(port)) die('SIM 尚未就绪，请稍后重试');
      // Confirm the live SIM before a destructive operation. A stale identity
      // cache must never authorize deleting SMS from a replacement card.
      let live = bounded('sms_tool -d ' + port + ' at ' + quote(profileCommand('iccid')), 5);
      if (profileRow('iccid', live).iccid != sim.iccid) die('SIM 已变化，请刷新后重试');
      let deleted = 0, errors = [], limited = false;
      for (let memory in profile.sms.memories) {
        let messages = []; try { messages = receiveMessages(memory, sim.iccid); } catch(e) { push(errors,''+e); continue; }
        let candidates = [];
        for (let row in messages) for (let saved in archive.records) {
          if (saved.key == row.key && saved.status == 'read' && type(row.storage_index) == 'int' && row.storage_index >= 0) { push(candidates,row); break; }
        }
        if (!length(candidates)) continue;
        let selected = bounded('CPE_OPERATOR_COMMAND=' + quote(profileCommand('smsStorageSelect',{memory})) + ' gcom -d ' + port + ' -s /usr/libexec/cpe-status/operator-at 2>&1',5);
        if (!match(selected, /\+CPMS:/) || !match(selected, /(^|[\r\n])OK([\r\n]|$)/) || match(selected, /ERROR/)) {push(errors,memory+' 短信存储选择失败');continue;}
        let removed = [];
        for (let row in candidates) {
          if (length(removed) + deleted >= 20) { limited = true; break; }
          let raw = bounded('CPE_OPERATOR_COMMAND=' + quote(profileCommand('smsDelete',{index:''+row.storage_index})) + ' gcom -d ' + port + ' -s /usr/libexec/cpe-status/operator-at 2>&1',5);
          if (match(raw, /(^|[\r\n])OK([\r\n]|$)/) && !match(raw,/ERROR/)) push(removed,row);
          else push(errors,memory+' 短信 '+row.storage_index+' 删除未确认');
        }
        try {
          let remaining = receiveMessages(memory,sim.iccid);
          for (let row in removed) {
            let exists = false; for (let current in remaining) if (current.storage_index == row.storage_index && current.key == row.key) exists = true;
            if (!exists) deleted++; else push(errors,memory+' 短信 '+row.storage_index+' 仍存在');
          }
        } catch(e) { push(errors,''+e); }
      }
      let result = { ...job,status:length(errors) ? 'error' : 'ok',data:{deleted,limited},message:'已清理 '+deleted+' 条模块/SIM短信，路由器历史保留'+(limited ? '；还有记录可继续清理' : '')+(length(errors) ? '；'+join('；',errors) : '') };
      save(cleanupFile,result); unlink(directory+'/sms-sync.json'); reply(result);
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
        let sim = readJSON(directory + '/sim-identity.json'), identity = sim?.present && sim.iccid ? sim.iccid : 'unknown';
        for (let memory in smsSupported ? profile.sms.memories : []) {
          // ME belongs to the modem; SM belongs to a known SIM. Do not invent
          // an SM owner while the manager is still identifying a new card.
          if (memory == 'SM' && identity == 'unknown') continue;
          try { for (let row in receiveMessages(memory,identity)) {
            if (index(archive.seen,row.key) >= 0 || index(archive.seen,smsTombstone(row)) >= 0) continue;
            row.id = archive.next++; push(archive.seen,row.key); push(archive.records,row); changed = true;
          } } catch(e) { push(warnings,''+e); }
        }
        if (changed) storeHistory(storage, archive);
        // Failed/unsupported storage is also throttled. Browser refresh cannot
        // turn a failing SM read into an unbounded series of AT queries.
        save(directory + '/sms-sync.json', { time: time(), warnings });
      }
      reply({ status: 'ok', data: archive.records, warnings });
    } else die('无效的短信操作');
  }
} catch(e) {
  let result = {status:'error',message:''+e};
  if (action == 'cleanup') save(cleanupFile,{...cleanupState(),...result});
  reply(result);
}
unlink(lock + '/pid'); rmdir(lock);
`
