// Generated ucode: trusted local JSON profile, no eval or shell snippets.
export const profileRuntime = String.raw`
function profileRegex(pattern) {
  if (type(pattern) != 'string' || length(pattern) > 4096) die('Invalid profile regex');
  return regexp(pattern);
}
function profileQuote(value) { return "'" + replace(value, /'/g, "'\\''") + "'"; }
function refreshProfile() {
  try {
    let device = substr(port, 5), root = getenv('CPE_STATUS_SYSFS') || '/sys';
    let path = realpath(root + '/class/tty/' + device + '/device') || realpath(root + '/class/tty/' + device) || ''; usbId = '';
    while (length(path) > length(root)) {
      let vendor = lc(text(path + '/idVendor')), product = lc(text(path + '/idProduct'));
      if (match(vendor + product, /^[0-9a-f]{8}$/)) { usbId = vendor + product; break; }
      let end = rindex(path, '/'); if (end < 0) break; path = substr(path, 0, end);
    }
    if (!usbId) die('无法识别 AT 串口对应的 USB VID/PID');
    let dir = getenv('CPE_STATUS_MODEM_DIRECTORY') || config.modemDirectory || '/etc/cpe-status/modem.d';
    if (!match(dir, /^\/[a-zA-Z0-9_./-]+$/) || index(dir, '..') >= 0) die('Invalid modem profile directory');
    let file = dir + '/' + usbId + '.conf', content = readfile(file);
    if (!content || length(content) > 262144) die('没有 USB ' + usbId + ' 的有效模块适配文件');
    // Include content, not only second-resolution mtime, so edits apply immediately.
    if (content == profileStamp && profile && index(profileKey, usbId + ':') == 0) return true;
    let value = json(content);
    if (value.schemaVersion != 1 || !value.commands || !value.groups || index(value.usbIds || [], usbId) < 0) die('模块适配文件 schema/USB ID 不匹配');
    profileRegex(value.modelPattern);
    for (let name, operation in value.commands) {
      if (index(['read','write'], operation.kind) < 0) die('Invalid profile operation kind');
      if (!match(name, /^[a-zA-Z][a-zA-Z0-9]*$/) || !match(operation.command || '', /^AT[ -~]+$/) || index(operation.command, "'") >= 0 || length(operation.command) > 1024) die('模块命令配置无效');
      for (let rule in operation.rules || []) { profileRegex(rule.regex); if (rule.segments) profileRegex(rule.segments); for (let field in values(rule.fields || {})) if (field.pattern) profileRegex(field.pattern); }
    }
    for (let group in values(value.groups)) {
      if (group.ttl < 1 || group.ttl > 604800 || !length(group.names || [])) die('Invalid profile cache group');
      for (let name in group.names) if (value.commands[name]?.kind != 'read') die('Read cache group cannot contain a write operation');
      for (let name in group.required || []) if (index(group.names, name) < 0) die('Required group operation is missing');
    }
    let fingerprint = match(command('sha256sum ' + profileQuote(file)), /^[0-9a-f]{64}/)?.[0];
    if (!fingerprint) die('Cannot fingerprint modem profile');
    profile = value; profileStamp = content; profileKey = usbId + ':' + fingerprint; profileError = ''; return true;
  } catch(e) { profile = null; profileKey = ''; profileError = '' + e; return false; }
}
refreshProfile();
function profileCommand(name, parameters) {
  if (!profile) die(profileError || '模块尚未适配');
  let operation = profile.commands[name];
  if (!operation) die('模块适配未提供操作：' + name);
  let cmd = operation.command;
  for (let key, pattern in operation.parameters || {}) {
    let value = parameters?.[key];
    if (type(value) != 'string' || !match(value, profileRegex('^(' + pattern + ')$')) || match(value, /[[:cntrl:]']/)) die('Invalid AT parameter: ' + key);
    cmd = replace(cmd, '{' + key + '}', value);
  }
  if (match(cmd, /[{}[:cntrl:]']/) || length(cmd) > 1024) die('Invalid rendered AT command');
  return cmd;
}
function profileBatch(names) {
  let result = [];
  for (let name in names) {
    if (profile?.commands[name]?.kind != 'read') die('Batch query cannot execute a write operation');
    push(result, substr(profileCommand(name), 2));
  }
  if (!length(result)) die('Empty AT operation group');
  return 'AT' + join(';', result);
}
function profileCsv(value) {
  let result = [], current = '', quoted = false;
  for (let i = 0; i < length(value); i++) {
    let c = substr(value, i, 1);
    if (c == '"') {
      if (quoted && substr(value, i + 1, 1) == '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (c == ',' && !quoted) { push(result, trim(current)); current = ''; }
    else current += c;
  }
  if (quoted) die('Unterminated AT CSV');
  push(result, trim(current)); return result;
}
function profileField(raw, rule) {
  if (raw != null && rule.pattern) raw = match(raw, profileRegex(rule.pattern))?.[1];
  if (raw == null || raw == '' || index(rule.unknown || [], raw) >= 0) {
    if (rule.optional) return null;
    die('Missing AT field ' + rule.index);
  }
  if (rule.map) { if (!(raw in rule.map)) die('Unknown AT enum ' + raw); return rule.map[raw]; }
  if (rule.type == 'number' || rule.type == 'hex') {
    if (!match(raw, rule.type == 'hex' ? /^[0-9a-fA-F]+$/ : /^-?[0-9]+(\.[0-9]+)?$/)) die('Invalid numeric AT field');
    let value = (rule.type == 'hex' ? hex(raw) : +raw) * (rule.scale ?? 1) + (rule.offset || 0);
    if ((value > 9007199254740991 || value < -9007199254740991) || (rule.min != null && value < rule.min) || (rule.max != null && value > rule.max)) die('AT field out of range');
    return value;
  }
  if (rule.type == 'boolean') { if (raw != '0' && raw != '1') die('Invalid AT boolean'); return raw == '1'; }
  return raw;
}
function profileParse(name, raw) {
  if (!profile?.commands[name]) die('Unsupported profile operation ' + name);
  let records = [];
  for (let line in split(raw || '', '\n')) for (let rule in profile.commands[name].rules || []) {
    let found = match(trim(line), profileRegex(rule.regex));
    if (!found) continue;
    let pieces = [found[1]];
    if (rule.segments) {
      pieces = []; let rest = found[1], segment;
      while ((segment = match(rest, profileRegex(rule.segments)))) {
        push(pieces, segment[1]); let pos = index(rest, segment[0]);
        if (!length(segment[0])) die('Empty AT segment'); rest = substr(rest, pos + length(segment[0]));
      }
    }
    for (let piece in pieces) {
      let fields = rule.format == 'csv' ? profileCsv(piece) : slice(found, 1);
      if (rule.minimumFields && length(fields) < rule.minimumFields) die('AT reply layout mismatch');
      let repeat = rule.repeat, count = repeat ? +fields[repeat.countIndex] : 1;
      if (count < 0 || int(count) != count || (repeat && (count > repeat.maximum || length(fields) != repeat.start + count * repeat.stride))) die('Invalid repeated AT fields');
      for (let i = 0; i < count; i++) {
        let data = repeat ? slice(fields, repeat.start + i * repeat.stride) : fields;
        let row = { ...(rule.constants || {}) };
        for (let key, field in rule.fields || {}) row[key] = profileField(data[field.index], field);
        push(records, row);
      }
    }
    break;
  }
  if (!length(records) && !profile.commands[name].allowEmpty) die('No matching data for operation ' + name);
  return records;
}
function profileRow(name, raw) { return profileParse(name, raw)[0] || {}; }
function profileAbsent(raw) { return profile && !!match(raw || '', profileRegex(profile.simAbsentPattern)); }
function requireProfile() {
  let cached = readJSON(directory + '/snapshot.json');
  let raw = cached?.device == port && cached?.profile_key == profileKey && time() - (cached.sampled.identity || 0) < cacheSeconds.identity ? cached.raw.identity : '';
  if (!raw) raw = bounded('sms_tool -d ' + port + ' at ' + profileQuote(profileCommand('model')), 5);
  let model = profileRow('model', raw).model;
  if (!match(model || '', profileRegex(profile.modelPattern))) die('模块型号与 USB 适配文件不匹配');
  return model;
}
`
