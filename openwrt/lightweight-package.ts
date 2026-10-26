import { mkdir, writeFile, cp, readFile } from 'node:fs/promises'
import { statusCollector } from './status-collector.ts'
import { roamingControl } from './roaming-control.ts'
import { modemControl, modemControlResult } from './modem-control.ts'
import { bandReader } from './band-control.ts'
import { cellLockReader } from './radio-settings.ts'
import { cellScanAt, cellScanReader } from './cell-scan.ts'
import { operatorAt, operatorReader } from './operators.ts'
import { speedSampler, speedSettings } from './speed-sampler.ts'
import { apnReader } from './apn-control.ts'
import { messaging } from './messaging.ts'
import { wwanManager, cpeInit, smsPoll } from './wwan-manager.ts'
import { compileApns } from '../shared/apn.ts'
import { licenseText } from '../docs/license.ts'

export async function generateLightweightPackage(root: string) {
  const write = async (path: string, content: string) => { const destination = `${root}/${path}`; await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true }); await writeFile(destination, content) }
  await write('files/usr/libexec/cpe-status-snapshot', statusCollector)
  await write('files/usr/libexec/cpe-status-speed', speedSampler)
  await write('files/usr/libexec/cpe-status-speed-settings', speedSettings)
  await write('files/usr/libexec/cpe-status-messaging', messaging)
  await write('files/usr/libexec/cpe-status-apn', apnReader)
  await write('files/usr/libexec/cpe-status-wwan', wwanManager)
  await write('files/usr/libexec/cpe-status-sms-poll', smsPoll)
  await write('files/etc/init.d/cpe-status', cpeInit)
  await write('files/usr/share/cpe-status/apns.json', JSON.stringify(compileApns(await readFile('data/apns-conf_8.xml', 'utf8'))))
  await cp('data/apns-conf_8.xml', `${root}/files/usr/share/cpe-status/apns-conf_8.xml`)

  await write('files/usr/libexec/cpe-status-roaming', roamingControl)
  await write('files/usr/libexec/cpe-status-control', modemControl)
  await write('files/usr/libexec/cpe-status-control-result', modemControlResult)
  await write('files/usr/libexec/cpe-status-bands', bandReader)
  await write('files/usr/libexec/cpe-status-cell-locks', cellLockReader)
  await write('files/usr/libexec/cpe-status-scan-at', cellScanAt)
  await write('files/usr/libexec/cpe-status-scan-result', cellScanReader)
  await write('files/usr/libexec/cpe-status-operators', operatorReader)
  await write('files/usr/libexec/cpe-status-operator-at', operatorAt)
  await write('files/etc/cpe-status.json', JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan', autoApn: true, smsStorage: '/etc/cpe-status/sms' }, null, 2))
  await write('files/usr/share/cpe-status/LICENSE', licenseText)
  await write('files/www/luci-static/resources/view/modem/cpe-status.js', `'use strict';
'require view';
return view.extend({ render:function() {
  var pages = [['仪表盘', '/'], ['频段与小区设置', '/band-lock'], ['运营商与APN设置', '/operators'], ['AT控制台', '/at-console'], ['短信', '/sms']];
  var frame = E('iframe', { src:L.resource('cpe-status/index.html')+'?embedded=1&source=quectel#/', title:'CPE Status', style:'width:100%;height:calc(100vh - 210px);min-height:640px;border:0' });
  var items = pages.map(function(page, index) {
    return E('li', { 'class':index === 0 ? 'cbi-tab' : 'cbi-tab-disabled', role:'presentation' }, [
      E('a', { href:'#', role:'tab', 'aria-selected':index === 0 ? 'true' : 'false', click:function(event) {
        event.preventDefault();
        items.forEach(function(item) { item.className = 'cbi-tab-disabled'; item.firstChild.setAttribute('aria-selected','false'); });
        this.parentNode.className = 'cbi-tab'; this.setAttribute('aria-selected','true');
        frame.contentWindow.location.hash = page[1];
      } }, page[0])
    ]);
  });
  return E('div', {}, [E('h2', {}, 'CPE Status'), E('ul', { 'class':'cbi-tabmenu', role:'tablist', 'aria-label':'Modem功能' }, items), frame]);
}, handleSave:null, handleSaveApply:null, handleReset:null });
`)
  await write('files/usr/share/luci/menu.d/luci-app-cpe-status.json', JSON.stringify({
    'admin/modem': { title: 'Modem', order: 65, action: { type: 'firstchild' } },
    'admin/modem/cpe-status': { title: 'CPE Status', order: 20, action: { type: 'view', path: 'modem/cpe-status' }, depends: { acl: ['luci-app-cpe-status'] } },
  }, null, 2))
  await write('files/usr/share/rpcd/acl.d/luci-app-cpe-status.json', JSON.stringify({ 'luci-app-cpe-status': { description: 'Read cached CPE modem status and control roaming, data, RF, bands, mode and cells', read: { ubus: { file: ['exec'] }, file: { '/usr/libexec/cpe-status-snapshot': ['exec'], '/usr/libexec/cpe-status-speed-settings': ['exec'], '/usr/libexec/cpe-status-control-result': ['exec'], '/usr/libexec/cpe-status-bands': ['exec'], '/usr/libexec/cpe-status-cell-locks': ['exec'], '/usr/libexec/cpe-status-scan-result': ['exec'], '/usr/libexec/cpe-status-operators': ['exec'] } }, write: { ubus: { file: ['exec'] }, file: { '/usr/libexec/cpe-status-apn': ['exec'], '/usr/libexec/cpe-status-messaging': ['exec'], '/usr/libexec/cpe-status-roaming': ['exec'], '/usr/libexec/cpe-status-control': ['exec'] } } } }, null, 2))
  await cp('build/www', `${root}/files/www/luci-static/resources/cpe-status`, { recursive: true })
  await write('Makefile', `include $(TOPDIR)/rules.mk
PKG_NAME:=luci-app-cpe-status
PKG_VERSION:=0.3.0
PKG_RELEASE:=0
PKG_LICENSE:=GPL-3.0-only
PKGARCH:=all
include $(INCLUDE_DIR)/package.mk
define Package/$(PKG_NAME)
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=CPE Status (Quectel monitor)
  DEPENDS:=+luci-base +rpcd-mod-file +ucode +ucode-mod-fs +ucode-mod-ubus +sms-tool +comgt
  CONFLICTS:=luci-app-openwrt-modem
endef
define Package/$(PKG_NAME)/conffiles
/etc/cpe-status.json
endef
define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$\${IPKG_INSTROOT}" ] || {
	rm -rf /www/luci-static/resources/openwrt-modem/
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null || true
	/etc/init.d/cpe-status enable
	/etc/init.d/cpe-status restart
}
exit 0
endef
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./files/. $(PKG_BUILD_DIR)/
endef
define Build/Compile
endef
define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/usr/libexec $(1)/usr/share $(1)/etc/init.d $(1)/www
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-snapshot $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-speed $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-speed-settings $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-messaging $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-apn $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-wwan $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-sms-poll $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/etc/init.d/cpe-status $(1)/etc/init.d/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-roaming $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-control $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-control-result $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-bands $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-cell-locks $(1)/usr/libexec/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-scan-at $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-scan-result $(1)/usr/libexec/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-operators $(1)/usr/libexec/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/usr/libexec/cpe-status-operator-at $(1)/usr/libexec/
	$(CP) $(PKG_BUILD_DIR)/usr/share/. $(1)/usr/share/
	$(INSTALL_CONF) $(PKG_BUILD_DIR)/etc/cpe-status.json $(1)/etc/
	$(CP) $(PKG_BUILD_DIR)/www/. $(1)/www/
	find $(1)/usr/share $(1)/www -type d -exec chmod 0755 {} +
	find $(1)/usr/share $(1)/www -type f -exec chmod 0644 {} +
endef
$(eval $(call BuildPackage,$(PKG_NAME)))
`)
}
