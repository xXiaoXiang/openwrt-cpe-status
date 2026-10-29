import { mkdir, writeFile, cp, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { statusCollector } from './status-collector.ts'
import { roamingControl } from './roaming-control.ts'
import { modemControl, modemControlResult } from './modem-control.ts'
import { bandReader } from './band-control.ts'
import { cellLockReader } from './radio-settings.ts'
import { cellScanAt, cellScanReader } from './cell-scan.ts'
import { operatorAt, operatorReader } from './operators.ts'
import { speedSampler, speedSettings } from './speed-sampler.ts'
import { apnReader } from './apn-control.ts'
import { apnDatabaseUpdater } from './apn-database.ts'
import { apnSourceNotices } from '../docs/apn-source.ts'
import { bundledApnDatabase } from '../data/apn-database.ts'
import { messaging } from './messaging.ts'
import { wwanManager, cpeInit, smsPoll } from './wwan-manager.ts'
import { validateAdapter } from '../backend/engine.ts'
import type { ModemProfile } from '../shared/modem-profile.ts'
import { packageManifest, packageRelease } from '../project.ts'
import { serviceStatus, serviceControl } from './service-control.ts'
import { luciStatusView } from './luci-view.ts'
import { qosHelper, qosWatch, qosRead, qosHotplug } from './qos.ts'
import { moduleQosCollector } from './module-qos.ts'
import { euiccRead, euiccControl } from './euicc.ts'
import { euiccBridge, euiccBridgeRunner, euiccBridgeCli, euiccRspRootCa } from './euicc-bridge.ts'
import { licenseText } from '../docs/license.ts'
import { defaultStatusConfig, pathMigration, pathMigrationPrepare } from './path-migration.ts'

export async function generateLightweightPackage(root: string) {
  const write = async (path: string, content: string) => { const destination = `${root}/${path}`; await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true }); await writeFile(destination, content) }
  const modemFiles = (await readdir('modem.d')).filter(name => /^[0-9a-f]{8}\.conf$/.test(name))
  if (!modemFiles.length) throw new Error('No modem profiles')
  for (const name of modemFiles) {
    const contents = await readFile(`modem.d/${name}`, 'utf8')
    const profile = JSON.parse(contents) as ModemProfile
    validateAdapter(profile)
    if (!profile.usbIds?.includes(name.slice(0, 8))) throw new Error(`Profile USB ID mismatch: ${name}`)
    await write(`files/etc/cpe-status/modem.d/${name}`, JSON.stringify(profile, null, 2) + '\n')
  }
  await write('files/etc/cpe-status/apns.local.json', JSON.stringify({ _comment: '用户 APN 扩展，优先于内置数据库；字段 carrier,mcc,mnc,apn,protocol,user,password,authtype,mvno_type,mvno_match_data；MCC/MNC须为字符串保留前导零。网页各SIM设置优先级更高。', apns: [] }, null, 2) + '\n')
  await write('files/usr/libexec/cpe-status/snapshot', statusCollector)
  await write('files/usr/libexec/cpe-status/speed', speedSampler)
  await write('files/usr/libexec/cpe-status/speed-settings', speedSettings)
  await write('files/usr/libexec/cpe-status/messaging', messaging)
  await write('files/usr/libexec/cpe-status/apn', apnReader)
  await write('files/usr/libexec/cpe-status/apn-database', apnDatabaseUpdater)
  await write('files/usr/libexec/cpe-status/wwan', wwanManager)
  await write('files/usr/libexec/cpe-status/sms-poll', smsPoll)
  await write('files/usr/libexec/cpe-status/qos', qosHelper)
  await write('files/usr/libexec/cpe-status/qos-watch', qosWatch)
  await write('files/usr/libexec/cpe-status/qos-read', qosRead)
  await write('files/usr/libexec/cpe-status/euicc-read', euiccRead)
  await write('files/usr/libexec/cpe-status/euicc-control', euiccControl)
  await write('files/usr/libexec/cpe-status/lpac-run', euiccBridgeRunner)
  await write('files/usr/libexec/cpe-status/esim-apdu-bridge', euiccBridge)
  await write('files/usr/libexec/cpe-status/lpac-test', euiccBridgeCli)
  await write('files/usr/libexec/cpe-status/migrate', pathMigration)
  await write('files/usr/share/cpe-status/certs/gsma-ci.pem', euiccRspRootCa)
  await write('files/usr/share/cpe-status/euicc-bridge-source.txt', 'eSIM stdio bridge adapted from fildunsky/luci-app-5gmodem\nCopyright 2026 Fil Dunsky. GPL-3.0-only.\nhttps://github.com/fildunsky/luci-app-5gmodem/tree/f495ea89c87c19194672666280e143e58993f7fa\nSources: root/usr/share/5gmodem/esim.sh (run_lpac), esim-apdu-bridge.sh.\nAdaptations: ucode protocol parser, curl HTTPS relay, shared process-group timeout, private temporary files, no blind APDU retries or unrelated-channel cleanup.\n')
  await write('files/etc/hotplug.d/usb/05-cpe-status-qos', qosHotplug)
  await write('files/usr/libexec/cpe-status/qos-collector.pl', moduleQosCollector)
  await write('files/etc/init.d/cpe-status', cpeInit)
  await write('files/usr/libexec/cpe-status/service-status', serviceStatus)
  await write('files/usr/libexec/cpe-status/service-control', serviceControl)
  const apnXml=await readFile('data/apns-conf_8.xml','utf8'), {entries,...apnMetadata}=bundledApnDatabase, apnJson=JSON.stringify(entries)
  await write('files/usr/share/cpe-status/apns.json', apnJson)
  await write('files/usr/share/cpe-status/apn-database-base.json',JSON.stringify({...apnMetadata,files:{'apns.json':createHash('sha256').update(apnJson).digest('hex'),'apns-conf_8.xml':createHash('sha256').update(apnXml).digest('hex')}}))
  for (const [name,contents] of Object.entries(apnSourceNotices)) await write('files/usr/share/cpe-status/apn-database-source/'+name,contents)
  await cp('data/apns-conf_8.xml', `${root}/files/usr/share/cpe-status/apns-conf_8.xml`)

  await write('files/usr/libexec/cpe-status/roaming', roamingControl)
  await write('files/usr/libexec/cpe-status/control', modemControl)
  await write('files/usr/libexec/cpe-status/control-result', modemControlResult)
  await write('files/usr/libexec/cpe-status/bands', bandReader)
  await write('files/usr/libexec/cpe-status/cell-locks', cellLockReader)
  await write('files/usr/libexec/cpe-status/scan-at', cellScanAt)
  await write('files/usr/libexec/cpe-status/scan-result', cellScanReader)
  await write('files/usr/libexec/cpe-status/operators', operatorReader)
  await write('files/usr/libexec/cpe-status/operator-at', operatorAt)
  await write('files/etc/cpe-status/config.json', defaultStatusConfig)
  await write('files/usr/share/cpe-status/LICENSE', licenseText)
  await write('files/www/luci-static/resources/view/modem/cpe-status.js', luciStatusView)
  await write('files/usr/share/luci/menu.d/luci-app-cpe-status.json', JSON.stringify({
    'admin/modem': { title: 'Modem', order: 65, action: { type: 'firstchild' } },
    'admin/modem/cpe-status': { title: 'CPE Status', order: 20, action: { type: 'view', path: 'modem/cpe-status' }, depends: { acl: ['luci-app-cpe-status'] } },
  }, null, 2))
  await write('files/usr/share/rpcd/acl.d/luci-app-cpe-status.json', JSON.stringify({ 'luci-app-cpe-status': { description: 'Read cached CPE modem status and control its service and modem settings', read: { ubus: { file: ['exec'] }, file: { '/usr/libexec/cpe-status/service-status': ['exec'], '/usr/libexec/cpe-status/snapshot': ['exec'], '/usr/libexec/cpe-status/speed-settings': ['exec'], '/usr/libexec/cpe-status/control-result': ['exec'], '/usr/libexec/cpe-status/bands': ['exec'], '/usr/libexec/cpe-status/cell-locks': ['exec'], '/usr/libexec/cpe-status/scan-result': ['exec'], '/usr/libexec/cpe-status/operators': ['exec'] } }, write: { ubus: { file: ['exec'] }, file: { '/usr/libexec/cpe-status/service-control': ['exec'], '/usr/libexec/cpe-status/apn': ['exec'], '/usr/libexec/cpe-status/messaging': ['exec'], '/usr/libexec/cpe-status/roaming': ['exec'], '/usr/libexec/cpe-status/control': ['exec'] } } } }, null, 2))
  const aclPath = `${root}/files/usr/share/rpcd/acl.d/luci-app-cpe-status.json`
  const acl = JSON.parse(await readFile(aclPath, 'utf8'))
  acl['luci-app-cpe-status'].read.file['/usr/libexec/cpe-status/qos-read'] = ['exec']
  acl['luci-app-cpe-status'].read.file['/usr/libexec/cpe-status/euicc-read'] = ['exec']
  acl['luci-app-cpe-status'].write.file['/usr/libexec/cpe-status/euicc-control'] = ['exec']
  acl['luci-app-cpe-status'].write.file['/usr/libexec/cpe-status/apn-database'] = ['exec']
  await writeFile(aclPath, JSON.stringify(acl, null, 2))
  await cp('build/www', `${root}/files/www/luci-static/resources/cpe-status`, { recursive: true })
  await write('Makefile', `include $(TOPDIR)/rules.mk
PKG_NAME:=luci-app-cpe-status
PKG_VERSION:=${packageManifest.version}
PKG_RELEASE:=${packageRelease}
PKG_LICENSE:=GPL-3.0-only
PKGARCH:=all
include $(INCLUDE_DIR)/package.mk
define Package/$(PKG_NAME)
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=CPE Status (configurable modem monitor)
  DEPENDS:=+luci-base +rpcd-mod-file +ucode +ucode-mod-fs +ucode-mod-ubus +sms-tool +comgt +adb +curl +ca-bundle
  CONFLICTS:=luci-app-openwrt-modem
endef
define Package/$(PKG_NAME)/conffiles
/etc/cpe-status/config.json
/etc/cpe-status/
${modemFiles.map(name => '/etc/cpe-status/modem.d/' + name).join('\n')}
/etc/cpe-status/apns.local.json
endef
define Package/$(PKG_NAME)/preinst
#!/bin/sh
${pathMigrationPrepare.replaceAll('$', () => '$$')}
exit 0
endef
define Package/$(PKG_NAME)/postinst
#!/bin/sh
set -e
"$\${IPKG_INSTROOT}/usr/libexec/cpe-status/migrate"
[ -n "$\${IPKG_INSTROOT}" ] || {
	rm -rf /www/luci-static/resources/openwrt-modem/
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null || true
	[ "$\${PKG_UPGRADE}" = "1" ] || /etc/init.d/cpe-status enable
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
	$(INSTALL_DIR) $(1)/usr/libexec/cpe-status $(1)/usr/share $(1)/etc/init.d $(1)/etc/hotplug.d/usb $(1)/www
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/etc/hotplug.d/usb/05-cpe-status-qos $(1)/etc/hotplug.d/usb/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/snapshot $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/speed $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/speed-settings $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/messaging $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/apn $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/apn-database $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/wwan $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/sms-poll $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/qos $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/qos-watch $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/qos-read $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/euicc-read $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/euicc-control $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/lpac-run $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/lpac-test $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/esim-apdu-bridge $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/migrate $(1)/usr/libexec/cpe-status/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/qos-collector.pl $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/etc/init.d/cpe-status $(1)/etc/init.d/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/service-status $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/service-control $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/roaming $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/control $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/control-result $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/bands $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/cell-locks $(1)/usr/libexec/cpe-status/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/scan-at $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/scan-result $(1)/usr/libexec/cpe-status/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/operators $(1)/usr/libexec/cpe-status/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/usr/libexec/cpe-status/operator-at $(1)/usr/libexec/cpe-status/
	$(CP) $(PKG_BUILD_DIR)/usr/share/. $(1)/usr/share/
	$(CP) $(PKG_BUILD_DIR)/etc/cpe-status $(1)/etc/
	find $(1)/etc/cpe-status -type d -exec chmod 0700 {} +
	find $(1)/etc/cpe-status -type f -exec chmod 0600 {} +
	$(CP) $(PKG_BUILD_DIR)/www/. $(1)/www/
	find $(1)/usr/share $(1)/www -type d -exec chmod 0755 {} +
	find $(1)/usr/share $(1)/www -type f -exec chmod 0644 {} +
endef
$(eval $(call BuildPackage,$(PKG_NAME)))
`)
}
