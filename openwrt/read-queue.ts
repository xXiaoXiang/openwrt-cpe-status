// Generated ucode shared by the short RPC readers and their detached workers.
// One persistent job per semantic read coalesces requests across browser sessions.
export const readQueueRuntime = String.raw`
const readKeys = ['bands', 'cell-locks', 'apn', 'operator', 'snapshot', 'euicc-probe', 'euicc-info', 'euicc-notifications', 'euicc-write'];
function readClock() { return +split(text('/proc/uptime'), ' ')[0]; }
function readPath(key) {
  if (index(readKeys, key) < 0) die('Invalid queued read');
  return directory + '/read-' + key + '.json';
}
function readJob(key) {
  let job = readJSON(readPath(key));
  if (!job || job.device != port || job.profile_key != profileKey) return null;
  if (job.status == 'pending' && ((!job.worker && readClock() - job.queued > 5) || (job.worker && !stat('/proc/' + job.worker)))) {
    job.status = 'error'; job.state = 'finished'; job.finished = readClock();
    job.message = '读取任务已中断，请重新读取'; save(readPath(key), job);
  }
  return job;
}
function readProgress(job) {
  return { job_id: job?.id, refreshing: job?.status == 'pending', queue_state: job?.state, retry_after_ms: 1000 };
}
function queueRead(key, executable, operation) {
  let path = readPath(key), gate = directory + '/read-submit-' + key;
  if (!match(executable, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid queued executable');
  let job = readJob(key);
  if (key != 'euicc-write' && downloadActivity().active) return downloadDeferred();
  if (job?.status == 'pending') return job;
  if (job?.status == 'error' && readClock() - job.finished < cacheSeconds.failure) return job;
  if (job?.status == 'ok' && readClock() - job.finished < 1) return job;
  if (!mkdir(gate, 0700)) {
    let owner = +text(gate + '/pid'), info = stat(gate);
    if (info && time() - info.mtime >= 2 && (!owner || !stat('/proc/' + owner))) { unlink(gate + '/pid'); rmdir(gate); }
    if (!mkdir(gate, 0700)) {
      // The winner publishes the ID before spawning its worker. A tiny bounded
      // submission wait lets simultaneous callers share that ID as well.
      for (let i = 0; i < 20; i++) { let current = readJob(key); if (current) return current; sleep(10); }
      return { status: 'pending', state: 'queued' };
    }
  }
  writefile(gate + '/pid', '' + pid);
  try {
    job = readJob(key);
    if (job?.status != 'pending' && !(job?.status == 'ok' && readClock() - job.finished < 1)
      && !(job?.status == 'error' && readClock() - job.finished < cacheSeconds.failure)) {
      job = { id: time() + '-' + pid, key, device: port, profile_key: profileKey,
        status: 'pending', state: 'queued', queued: readClock(), started_at: time(), operation,
        priority: key == 'euicc-write' ? -1 : key == 'snapshot' ? 1 : 0 };
      save(path, job);
      system((key == 'euicc-write' ? '/usr/bin/setsid ' : '') + executable + ' --refresh ' + job.id + ' </dev/null >' + directory + '/read-' + key + '.log 2>&1 &');
    }
  } catch(e) { unlink(gate + '/pid'); rmdir(gate); die(e); }
  unlink(gate + '/pid'); rmdir(gate);
  return job;
}
function pendingReads(manualOnly) {
  let result = [];
  for (let key in readKeys) {
    if (manualOnly && key == 'snapshot') continue;
    let job = readJob(key);
    if (job?.status == 'pending') push(result, job);
  }
  return sort(result, (a, b) => a.priority - b.priority || a.queued - b.queued || (a.key < b.key ? -1 : a.key == b.key ? 0 : 1));
}
function manualReadPending() { return length(pendingReads(true)) > 0; }
function releaseReadLock() {
  let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock';
  if (+text(lock + '/pid') == pid) { unlink(lock + '/pid'); rmdir(lock); }
}
function finishRead(job, error) {
  releaseReadLock();
  let current = readJSON(readPath(job.key));
  if (current?.id != job.id) return;
  job.status = error ? 'error' : 'ok'; job.state = 'finished'; job.finished = readClock(); job.message = error || '';
  save(readPath(job.key), job);
}
function beginRead(key, id) {
  let job = readJob(key);
  if (!job || job.id != id || job.status != 'pending' || (job.worker && job.worker != pid)) return null;
  job.worker = pid; save(readPath(key), job);
  let deadline = readClock() + 45, lock = getenv('CPE_STATUS_LOCK') || directory + '/lock';
  while (readClock() < deadline) {
    // Keep already queued reads dormant throughout a download. The download
    // has its own bounded lifetime; its duration does not spend the read TTL.
    if (key != 'euicc-write' && downloadActivity().active) { deadline=readClock()+45; sleep(250); continue; }
    let head = pendingReads(false)[0];
    if (head?.key == key && head.id == id) {
      let acquired = mkdir(lock, 0700);
      if (!acquired) {
        let owner = +text(lock + '/pid'), info = stat(lock);
        if (info && time() - info.mtime >= 2 && (!owner || !stat('/proc/' + owner))) { unlink(lock + '/pid'); rmdir(lock); acquired = mkdir(lock, 0700); }
      }
      if (acquired) {
        writefile(lock + '/pid', '' + pid);
        if (!refreshProfile() || job.profile_key != profileKey) { finishRead(job, '模块或适配文件已变化，请重新读取'); return null; }
        job.state = 'running'; save(readPath(key), job); return job;
      }
    }
    sleep(100);
  }
  finishRead(job, 'AT 队列等待超时，请稍后重新读取'); return null;
}
`;
