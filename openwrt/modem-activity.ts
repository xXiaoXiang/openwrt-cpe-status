// File-only activity check shared by every helper, including background daemons.
// A browser disappearing never owns or cancels the detached download worker.
export const modemActivityRuntime = String.raw`
function downloadActivity() {
  let job=readJSON(directory+'/read-euicc-write.json');
  let now=+split(text('/proc/uptime'),' ')[0];
  if (job?.status=='pending' && job.operation=='download' && now-job.queued<300) {
    let alive=job.worker ? stat('/proc/'+job.worker) && index(text('/proc/'+job.worker+'/stat'),') Z ')<0 : now-job.queued<5;
    if (alive) return {active:true,source:'api',job_id:job.id,phase:job.state};
  }
  let cli=readJSON(directory+'/euicc-cli-download.json');
  if (cli?.pid && cli.until>time() && stat('/proc/'+cli.pid) && index(text('/proc/'+cli.pid+'/stat'),') Z ')<0)
    return {active:true,source:'cli',phase:'running'};
  return {active:false};
}
function downloadDeferred() {
  return {status:'deferred',paused:true,submitted:false,retry_after_ms:1000,activity:downloadActivity(),message:'eUICC下载期间暂停Modem操作'};
}
`;
