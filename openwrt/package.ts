import { mkdir, writeFile, cp } from 'node:fs/promises'
import { exampleConfig } from '../backend/config.ts'
import { licenseText } from '../docs/license.ts'

export async function generatePackage(root: string) {
  const write = async (path: string, content: string) => { const destination = `${root}/${path}`; await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true }); await writeFile(destination, content) }
  const pages = [
    ['dashboard', '仪表盘', '/'], ['euicc', 'eUICC管理', '/euicc'], ['network', '网络状态', '/network'], ['sms', '短信管理', '/sms'], ['at-console', 'AT 控制台', '/at-console'],
  ]
  const menu: Record<string, unknown> = {
    'admin/modem': { title: 'Modem', order: 65, action: { type: 'firstchild' }, depends: { acl: ['luci-app-openwrt-modem'] } },
    'admin/modem/cpe-status': { title: 'CPE Status', order: 1, action: { type: 'view', path: 'openwrt-modem/cpe-status' } },
  }
  await write('files/www/luci-static/resources/view/openwrt-modem/cpe-status.js', `'use strict';
'require view';
return view.extend({
  render: function() {
    var pages = ${JSON.stringify(pages)};
    var frame = E('iframe', { src: L.resource('cpe-status/index.html') + '?embedded=1#/', title:'CPE Status', style:'width:100%;height:calc(100vh - 210px);min-height:640px;border:0' });
    var items = pages.map(function(page, index) {
      return E('li', { 'class':index === 0 ? 'cbi-tab' : 'cbi-tab-disabled', role:'presentation' }, [
        E('a', { href:'#', role:'tab', 'aria-selected':index === 0 ? 'true' : 'false', click:function(event) {
          event.preventDefault();
          items.forEach(function(item) { item.className = 'cbi-tab-disabled'; item.firstChild.setAttribute('aria-selected','false'); });
          this.parentNode.className = 'cbi-tab'; this.setAttribute('aria-selected','true');
          frame.contentWindow.location.hash = page[2];
        } }, page[1])
      ]);
    });
    return E('div', {}, [E('h2', {}, 'CPE Status'), E('ul', { 'class':'cbi-tabmenu', role:'tablist', 'aria-label':'Modem功能' }, items), frame]);
  }, handleSaveApply:null, handleSave:null, handleReset:null
});
`)
  await write('files/usr/share/luci/menu.d/luci-app-openwrt-modem.json', JSON.stringify(menu, null, 2))
  await write('files/usr/share/rpcd/acl.d/luci-app-openwrt-modem.json', JSON.stringify({ 'luci-app-openwrt-modem': { description: 'Modem monitoring and explicit hardware operations', read: { ubus: { 'openwrt-modem': ['read'] } }, write: { ubus: { 'openwrt-modem': ['write'] } } } }, null, 2))
  await write('files/etc/openwrt-modem/config.json', JSON.stringify(exampleConfig, null, 2))
  await write('files/usr/share/openwrt-modem/LICENSE', licenseText)
  await write('files/usr/libexec/rpcd/openwrt-modem', '#!/bin/sh\nexec /usr/bin/node /usr/share/openwrt-modem/rpc-bridge.mjs "$@"\n')
  await write('files/etc/init.d/openwrt-modem', `#!/bin/sh /etc/rc.common
START=95
STOP=10
USE_PROCD=1
start_service() {
    procd_open_instance
    procd_set_param command /usr/bin/node /usr/share/openwrt-modem/daemon.mjs --config /etc/openwrt-modem/config.json
    procd_set_param respawn 3600 5 5
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_set_param file /etc/openwrt-modem/config.json
    procd_close_instance
}
`)
  await cp('build/daemon.mjs', `${root}/files/usr/share/openwrt-modem/daemon.mjs`)
  await cp('build/rpc-bridge.mjs', `${root}/files/usr/share/openwrt-modem/rpc-bridge.mjs`)
  await cp('build/adapters', `${root}/files/usr/share/openwrt-modem/adapters`, { recursive: true })
  await cp('build/www', `${root}/files/www/luci-static/resources/cpe-status`, { recursive: true })
  await write('Makefile', `include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-openwrt-modem
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-only
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/$(PKG_NAME)
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=USB Modem Monitor
  DEPENDS:=+node +rpcd +luci-base +coreutils-stty
endef

define Package/$(PKG_NAME)/conffiles
/etc/openwrt-modem/config.json
/etc/openwrt-modem/state/
endef

define Build/Prepare
  mkdir -p $(PKG_BUILD_DIR)
  $(CP) ./files/. $(PKG_BUILD_DIR)/
endef

define Build/Compile
endef

define Package/$(PKG_NAME)/install
  $(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/openwrt-modem $(1)/usr/share/openwrt-modem $(1)/usr/libexec/rpcd
  $(INSTALL_BIN) $(PKG_BUILD_DIR)/etc/init.d/openwrt-modem $(1)/etc/init.d/
  $(INSTALL_CONF) $(PKG_BUILD_DIR)/etc/openwrt-modem/config.json $(1)/etc/openwrt-modem/
  $(CP) $(PKG_BUILD_DIR)/usr/share/. $(1)/usr/share/
  $(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/rpcd/openwrt-modem $(1)/usr/libexec/rpcd/
  $(INSTALL_DIR) $(1)/www
  $(CP) $(PKG_BUILD_DIR)/www/. $(1)/www/
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
`)
}
