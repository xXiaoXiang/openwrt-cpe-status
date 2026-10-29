// LuCI loads this generated view directly; the existing React application stays
// in one iframe so switching tabs preserves its data and pending operations.
export const luciStatusView = String.raw`'use strict';
'require view';
'require fs';
'require poll';
'require ui';
return view.extend({
  busy: false,
  state: null,
  readStatus: function() {
    return fs.exec('/usr/libexec/cpe-status/service-status', []).then(function(result) {
      var response = JSON.parse(result.stdout || '{}');
      if (result.code !== 0 || response.status !== 'ok' || !response.data)
        throw new Error(response.message || '无法读取服务状态');
      return response.data;
    });
  },
  load: function() {
    return this.readStatus().catch(function() { return null; });
  },
  refreshStatus: function() {
    if (this.busy) return Promise.resolve();
    return this.readStatus().then(L.bind(function(state) {
      this.state = state; this.updateStatus();
    }, this)).catch(L.bind(function() {
      this.state = null; this.updateStatus();
    }, this));
  },
  updateStatus: function() {
    var state = this.state, known = !!state, count = known ? state.running : 0;
    this.statusNode.textContent = !known ? '状态未知' : count === state.total ? '运行中' : count ? '部分运行 (' + count + '/' + state.total + ')' : '未运行';
    this.statusNode.style.color = !known ? 'var(--text-color-secondary, #888)' : count === state.total ? '#269f42' : count ? '#b7791f' : '#d63638';
    var names = { wwan:'自动 APN', speed:'网速采样', sms:'短信同步' };
    this.statusNode.title = known ? state.processes.map(function(p) { return (names[p.name] || p.name) + '：' + (p.running ? '运行中' : '未运行'); }).join('\n') : '无法读取服务状态';
    this.runButton.textContent = count ? '停止' : '启动';
    this.runButton.setAttribute('data-action', count ? 'stop' : 'start');
    this.enableButton.textContent = known && state.enabled ? '禁用自启' : '启用自启';
    this.enableButton.setAttribute('data-action', known && state.enabled ? 'disable' : 'enable');
    [this.runButton, this.enableButton, this.restartButton].forEach(L.bind(function(button) {
      button.disabled = this.busy || !known || !L.hasViewPermission();
    }, this));
  },
  handleService: function(event) {
    if (this.busy || !this.state || !L.hasViewPermission()) return Promise.resolve();
    var button = event.currentTarget, action = button.getAttribute('data-action');
    this.busy = true; this.updateStatus(); button.classList.add('spinning');
    return fs.exec('/usr/libexec/cpe-status/service-control', [action]).then(function(result) {
      var response = JSON.parse(result.stdout || '{}');
      if (result.code !== 0 || response.status !== 'ok') throw new Error(response.message || '服务操作失败');
    }).catch(function(error) {
      ui.addNotification(null, E('p', {}, error.message || String(error)), 'error');
    }).finally(L.bind(function() {
      button.classList.remove('spinning'); this.busy = false;
      this.updateStatus(); return this.refreshStatus();
    }, this));
  },
  render: function(state) {
    this.state = state;
    this.statusNode = E('strong', { 'data-cpe-service-status':'', 'aria-live':'polite' }, '');
    var click = L.bind(this.handleService, this);
    this.runButton = E('button', { 'class':'cbi-button cbi-button-action', click:click }, '');
    this.enableButton = E('button', { 'class':'cbi-button cbi-button-neutral', click:click, title:'仅改变开机自启设置，不改变当前运行状态' }, '');
    this.restartButton = E('button', { 'class':'cbi-button cbi-button-action', 'data-action':'restart', click:click }, '重启');
    this.updateStatus();
    var bar = E('div', { 'class':'cpe-service-bar' }, [
      E('div', { 'class':'cpe-service-state' }, [this.statusNode]),
      E('div', { 'class':'cpe-service-actions' }, [this.runButton, this.enableButton, this.restartButton])
    ]);
    var self = this, loadedSettings = false;
    var storageInput = E('input', { 'class':'cbi-input-text', type:'text', value:'/etc/cpe-status/sms', style:'width:100%;max-width:560px', 'aria-label':'短信保存目录' });
    var settingsNotice = E('p', { 'aria-live':'polite' }, '');
    function messaging(args) {
      return fs.exec('/usr/libexec/cpe-status/messaging', args).then(function(result) {
        var response = JSON.parse(result.stdout || '{}');
        if (result.code !== 0 || response.status !== 'ok') throw new Error(response.message || '短信设置操作失败');
        return response.data;
      });
    }
    function report(error) { settingsNotice.textContent = error.message || String(error); settingsNotice.style.color = '#d63638'; }
    function readSettings() {
      if (loadedSettings) return;
      messaging(['config']).then(function(data) { storageInput.value = data.path; loadedSettings = true; }).catch(report);
    }
    var savePath = E('button', { 'class':'cbi-button cbi-button-save', disabled:!L.hasViewPermission(), click:function() {
      var button = this; button.disabled = true; button.classList.add('spinning');
      messaging(['config', storageInput.value]).then(function(data) {
        storageInput.value = data.path; settingsNotice.textContent = '保存成功，现有历史已复制到新目录'; settingsNotice.style.color = '#269f42';
      }).catch(report).finally(function() {button.disabled = !L.hasViewPermission();button.classList.remove('spinning');});
    } }, '保存路径');
    var checkStorage = E('button', { 'class':'cbi-button cbi-button-action', disabled:!L.hasViewPermission(), click:function() {
      var button = this; button.disabled = true; button.classList.add('spinning');
      messaging(['storage-check']).then(function(data) {
        settingsNotice.textContent = '目录可读写：' + data.path + '；归档记录 ' + data.records + ' 条，未读记录 ' + data.unread + ' 条' + (data.warnings.length ? '；' + data.warnings.join('；') : '');
        settingsNotice.style.color = data.warnings.length ? '#b7791f' : '#269f42';
      }).catch(report).finally(function() {button.disabled = !L.hasViewPermission();button.classList.remove('spinning');});
    } }, '检测短信存储');
    var settings = E('div', { 'data-cpe-settings':'', style:'display:none' }, [
      bar,
      E('div', { 'class':'cbi-section' }, [
        E('h3', {}, '短信存储'),
        E('div', { 'class':'cbi-value' }, [E('label', { 'class':'cbi-value-title' }, '保存目录'),
          E('div', { 'class':'cbi-value-field' }, [storageInput, E('div', { 'class':'cbi-value-description' }, '支持挂载磁盘，原历史保留。')])]),
        E('div', { 'class':'cpe-settings-actions' }, [savePath, checkStorage]), settingsNotice
      ])
    ]);
    var pages = [['状态', '/'], ['频段/小区', '/band-lock'], ['运营商/APN', '/operators'], ['AT', '/at-console'], ['短信', '/sms'], ['eUICC', '/euicc']];
    pages.push(['插件设置', null]);
    var frame = E('iframe', { src:L.resource('cpe-status/index.html')+'?embedded=1&source=quectel#/', title:'CPE Status', style:'width:100%;height:calc(100vh - 165px);min-height:640px;border:0' });
    var items = pages.map(function(page, index) {
      return E('li', { 'class':index === 0 ? 'cbi-tab' : 'cbi-tab-disabled', role:'presentation', style:page[1] === '/euicc' ? 'display:none' : '' }, [
        E('a', { href:'#', role:'tab', 'aria-selected':index === 0 ? 'true' : 'false', click:function(event) {
          event.preventDefault();
          items.forEach(function(item) { item.className = 'cbi-tab-disabled'; item.firstChild.setAttribute('aria-selected','false'); });
          this.parentNode.className = 'cbi-tab'; this.setAttribute('aria-selected','true');
          var isSettings = page[1] === null;
          frame.style.display = isSettings ? 'none' : '';
          settings.style.display = isSettings ? '' : 'none';
          self.settingsActive = isSettings;
          if (isSettings) { readSettings(); self.refreshStatus(); }
          else frame.contentWindow.location.hash = page[1];
        } }, page[0])
      ]);
    });
    if (this.euiccListener) window.removeEventListener('message', this.euiccListener);
    this.euiccListener = function(event) {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow || event.data?.type !== 'cpe-status-euicc' || typeof event.data.available !== 'boolean') return;
      items[5].style.display = event.data.available ? '' : 'none';
      if (!event.data.available && !self.settingsActive && frame.contentWindow.location.hash === '#/euicc') {
        frame.contentWindow.location.hash = '/';
        items.forEach(function(item,index) { item.className = index === 0 ? 'cbi-tab' : 'cbi-tab-disabled'; item.firstChild.setAttribute('aria-selected',index === 0 ? 'true' : 'false'); });
      }
    };
    window.addEventListener('message', this.euiccListener);
    poll.add(function() { if (self.settingsActive) return self.refreshStatus(); }, 5);
    return E('div', {}, [E('style', {}, '.cpe-service-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;flex-wrap:wrap}.cpe-service-state{display:flex;align-items:center;gap:8px;flex:0 0 auto;max-width:100%;line-height:1.6}.cpe-service-actions{display:flex;gap:8px;margin-left:auto;flex:0 0 auto;max-width:100%;flex-wrap:wrap;justify-content:flex-end}.cpe-service-actions button{white-space:nowrap}.cpe-settings-actions{display:flex;gap:8px;flex-wrap:wrap}'), E('ul', { 'class':'cbi-tabmenu', role:'tablist', 'aria-label':'Modem功能' }, items), frame, settings]);
  }, handleSave:null, handleSaveApply:null, handleReset:null
});
`
