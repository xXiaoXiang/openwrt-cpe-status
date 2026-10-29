// The modem's ME store survives SIM changes. Its identity must not contain the
// current ICCID or storage slot (slots can be reused or renumbered).
export const smsArchiveRuntime = String.raw`
function smsMemory(row) { return row.memory || match(row.key || '', /^[^:]+:(ME|SM):[0-9]+:/)?.[1] || 'ME'; }
function smsKey(row) {
  let memory = smsMemory(row), scope = memory == 'SM' ? 'SM:' + (row.sim || 'unknown') : 'ME';
  return 'sms-v2:' + sprintf('%J', [scope, row.phone_number, row.timestamp, row.content, row.reference ?? null, row.part ?? null, row.total ?? null]);
}
function smsTombstone(row) {
  return 'sms-deleted:' + sprintf('%J', [smsMemory(row) == 'SM' ? 'SM:' + (row.sim || 'unknown') : 'ME', row.phone_number, row.timestamp, row.content]);
}
function normalizeHistory(value) {
  let records = [], found = {}, seen = [], changed = value.version != 2;
  for (let key in value.seen || []) {
    // Keep old tombstones when local history was explicitly cleared. Legacy
    // keys did not store multipart metadata, so retain their content identity.
    let old = match(key, /^([^:]+):(ME|SM):[0-9]+:([^:]*):([0-9]{4}-[0-9T:.+-]+Z):(.*)$/);
    let next = old ? smsTombstone({ memory:old[2], sim:old[1], phone_number:old[3], timestamp:old[4], content:old[5] }) : key;
    if (index(seen, next) < 0) push(seen, next);
  }
  for (let row in value.records || []) {
    if (row.direction != 'incoming') { push(records, row); continue; }
    let key = smsKey(row), prior = found[key];
    if (prior) {
      // Reading any duplicate means the retained message is already read.
      if (row.status == 'read') prior.status = 'read';
      if (prior.sim == 'unknown' && row.sim && row.sim != 'unknown') prior.sim = row.sim;
      changed = true; continue;
    }
    row.memory = smsMemory(row);
    if (row.key != key) changed = true;
    row.key = key; found[key] = row; push(records, row);
    if (index(seen, key) < 0) { push(seen, key); changed = true; }
  }
  return { version:2, next:value.next || 1, records, seen, _dirty:changed };
}
function history(path) { return normalizeHistory(readJSON(path + '/cpe-sms-history.json') || { version:2, next:1, records:[], seen:[] }); }
function storeHistory(path, value) {
  let file = path + '/cpe-sms-history.json', original = readJSON(file);
  if (original && original.version != 2 && !stat(path + '/cpe-sms-history.pre-v2.json')) {
    save(path + '/cpe-sms-history.pre-v2.json', original);
  }
  delete value._dirty; save(file, value);
}
function receiveMessages(memory, identity) {
  if (index(['ME','SM'], memory) < 0) die('无效短信存储');
  let raw = bounded('sms_tool -d ' + port + ' -s ' + memory + ' -j -f ' + quote('%Y-%m-%dT%H:%M:%SZ') + ' recv 2>/dev/null', profile.sms.receiveTimeout), value = null;
  try { value = json(raw); } catch(e) {}
  if (!value || type(value.msg) != 'array') die(memory + ' 短信读取暂未成功');
  let result = [];
  for (let msg in value.msg) {
    if (msg.error || type(msg.sender) != 'string' || type(msg.content) != 'string' || !length(msg.timestamp || '')) die(memory + ' 短信数据不完整');
    let row = { direction:'incoming', phone_number:msg.sender, timestamp:msg.timestamp, content:msg.content, status:'received', reference:msg.reference, part:msg.part, total:msg.total, sim:identity, memory, storage_index:msg.index };
    row.key = smsKey(row); push(result, row);
  }
  return result;
}
`;
