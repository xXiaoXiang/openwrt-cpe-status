import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Divider, ListSubheader, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { SimCard, SystemUpdateAlt } from '@mui/icons-material'
import { alpha, darken } from '@mui/material/styles'
import { request } from '../api/request'
import { useCapabilities } from '../contexts/CapabilitiesContext'
import { validateApnSettings, type ApnSettings as Settings, type ApnStatus, type ApnDatabaseReply, type ApnChoice, type ApnDeleteRequest } from '../../../shared/apn-settings.ts'
import type { ApiResponse } from '../../../shared/adapter.ts'
import { operationSupported } from '../../../shared/availability.ts'
import { isDeferredMessage } from '../api/modemPolling'

const protocols={ipv4:'IPv4',ipv6:'IPv6',ipv4v6:'IPv4/IPv6'}
const same=(a:Settings,b?:Settings) => !!b && a.apn.toLowerCase()===b.apn.toLowerCase() && a.pdptype===b.pdptype && a.auth===b.auth && a.username===b.username && a.password===b.password
const choiceText=(item:ApnChoice) => `${item.settings.apn} · ${protocols[item.settings.pdptype]}${item.carrier && item.source!=='custom' ? ` · ${item.carrier}` : ''}${item.settings.auth!=='none' ? ` · ${item.settings.auth.toUpperCase()}` : ''}${item.settings.username ? ` · ${item.settings.username}` : ''}`

export default function ApnSettings() {
  const capabilities = useCapabilities()
  const profile = capabilities?.modem_profile
  const permitted = capabilities?.writes_enabled === true
  const writable = permitted && (!profile || ['simPin', 'iccid', 'radio'].every(name => operationSupported(profile, name)))
  const [status, setStatus] = useState<ApnStatus>()
  const [form, setForm] = useState<Settings>()
  const [saving, setSaving] = useState(false), [reading, setReading] = useState(false)
  const [databaseBusy,setDatabaseBusy]=useState(false)
  const [manual,setManual]=useState(false)
  const [listOpen,setListOpen]=useState(false), [deleteConfirmation,setDeleteConfirmation]=useState<ApnDeleteRequest>()
  const [deleting,setDeleting]=useState(false)
  const [notice, setNotice] = useState<{ severity: 'error' | 'info' | 'success'; text: string }>()
  const active = useRef(true), pending = useRef(false), dirty = useRef(false), writing = useRef(false), updatingDatabase=useRef(false), simIdentity=useRef<string | undefined>(undefined)
  const readRevision=useRef(0)
  const selectField=useRef<HTMLDivElement>(null)
  const read = useCallback(async (refresh = false) => {
    if (pending.current) return
    pending.current = true
    const revision=readRevision.current
    if (refresh) setReading(true)
    try {
      const result = await request<ApiResponse<ApnStatus> & { refreshing?: boolean }>(refresh ? '/apn/refresh' : '/apn')
      if (!active.current || revision!==readRevision.current) return
      if (result.data) {
        setStatus(result.data)
        if (simIdentity.current!==result.data.iccid) { simIdentity.current=result.data.iccid; dirty.current=false; setDeleteConfirmation(undefined) }
        if (!dirty.current && !writing.current) { setForm(result.data.preferred || result.data.settings); setManual(false) }
      }
      if (result.status === 'error') setNotice({ severity: 'error', text: result.message })
      return result.refreshing
    } catch (error) {
      if (isDeferredMessage(String(error))) return true
      if (active.current) setNotice({ severity: 'error', text: String(error) })
    }
    finally { pending.current = false; if (active.current) setReading(false) }
  }, [])
  const reload = useCallback(async () => {
    let refreshing = await read(true)
    for (let i = 0; i < 65 && refreshing && active.current; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (active.current) refreshing = await read()
    }
  }, [read])
  useEffect(() => {
    active.current = true
    if (permitted) void reload()
    return () => { active.current = false }
  }, [reload, permitted])
  useEffect(() => {
    if (!saving) return
    const timer = setInterval(() => void read(), 1500)
    return () => clearInterval(timer)
  }, [saving, read])
  const update = (key: keyof Settings, value: string) => {
    dirty.current = true; setManual(true)
    setForm(current => current ? { ...current, [key]: value } : current)
  }
  const save = async () => {
    if (!form || writing.current || !writable) return
    let target: Settings
    try { target = validateApnSettings(form) } catch (error) { setNotice({ severity: 'error', text: String(error) }); return }
    writing.current = true; setSaving(true); setNotice(undefined)
    try {
      const result = await request<ApiResponse<ApnStatus>>('/apn', { method: 'POST', body: JSON.stringify(target) })
      if (!active.current) return
      if (result.data) setStatus(result.data)
      if (result.status === 'ok') dirty.current = false
      setNotice({ severity: result.status === 'ok' ? 'success' : result.status === 'deferred' ? 'info' : 'error', text: result.message })
    } catch (error) { if (active.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { writing.current = false; if (active.current) { setSaving(false); void reload() } }
  }
  const updateDatabase=async () => {
    if (updatingDatabase.current || !permitted) return
    updatingDatabase.current=true; setDatabaseBusy(true); setNotice(undefined)
    try {
      let result=await request<ApnDatabaseReply>('/apn/database',{method:'POST'})
      for (let i=0;result.status==='pending' && i<55 && active.current;i++) {
        await new Promise(resolve=>setTimeout(resolve,2000))
        if (active.current) result=await request<ApnDatabaseReply>('/apn/database')
      }
      if (!active.current) return
      setNotice({severity:result.status==='ok' ? 'success' : result.status==='error' ? 'error' : 'info',text:result.message || (result.status==='pending' ? '更新仍在后台进行，可稍后再次查看' : 'APN 数据库检测完成')})
      await read()
    } catch(error) { if (active.current) setNotice({severity:'error',text:String(error)}) }
    finally { updatingDatabase.current=false; if (active.current) setDatabaseBusy(false) }
  }
  const remove=async (item:ApnChoice) => {
    if (writing.current || !permitted || item.source!=='custom' || !status?.iccid) return
    const target:ApnDeleteRequest={iccid:status.iccid,settings:{...item.settings}}
    if (deleteConfirmation?.iccid!==target.iccid || !same(target.settings,deleteConfirmation.settings)) { setDeleteConfirmation(target); return }
    writing.current=true; readRevision.current++; setDeleting(true); setNotice(undefined)
    try {
      const result=await request<ApiResponse<ApnStatus>>('/apn/custom',{method:'DELETE',body:JSON.stringify(target)})
      if (!active.current) return
      if (result.data) {
        setStatus(previous=>({...previous,...result.data!}))
        if (!dirty.current) { setForm(result.data.preferred || result.data.settings); setManual(false) }
      }
      if (result.status==='ok') setDeleteConfirmation(undefined)
      setNotice({severity:result.status==='ok' ? 'success' : result.status==='deferred' ? 'info' : 'error',text:result.message || '个人 APN 设置已删除'})
    } catch(error) { if (active.current) setNotice({severity:'error',text:String(error)}) }
    finally { writing.current=false; if (active.current) setDeleting(false) }
  }
  const choice=manual ? '' : status?.choices?.find(item=>same(item.settings,form))?.id || ''
  const manualLabel=<Chip size="small" label="手动修改" sx={theme=>({bgcolor:theme.palette.mode==='dark' ? darken(theme.palette.primary.main,0.4) : theme.palette.primary.main,color:'#fff'})} />
  return <Card variant="outlined" data-apn-settings><CardContent><Stack spacing={2.5}>
    <Box display="flex" alignItems="center" gap={1} flexWrap="wrap"><SimCard color="primary" /><Typography variant="h6" flex={1} sx={{whiteSpace:'nowrap',minWidth:'max-content'}}>APN 配置</Typography>
      <Box display="flex" gap={1} sx={{ml:'auto',flexShrink:0}}>
        <Button disabled={!permitted || saving || deleting || databaseBusy} onClick={()=>void updateDatabase()} startIcon={databaseBusy ? <CircularProgress size={16}/> : <SystemUpdateAlt/>}>检测 APN 数据库更新</Button>
        <Button disabled={!writable || saving || deleting || reading} onClick={() => { dirty.current = false; void reload() }}>读取配置</Button>
      </Box></Box>
    {status?.database && <Typography variant="caption" color="text.secondary">数据库：{status.database.version} · {status.database.count} 条</Typography>}
    {status?.protocol_fallback && <Typography variant="caption" color="text.secondary">{status.protocol_fallback.user_override ? '已记录 IPv4 回退，当前优先使用自定义协议' : status.protocol_fallback.testing ? '正在验证 IPv4 连接' : '已记住此运营商/APN 使用 IPv4'}</Typography>}
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" data-active-apn>
      <Typography variant="body2">当前APN</Typography>
      {status?.active_supported === false ? <Typography color="text.secondary">-</Typography> : status?.sampled_at ? <Chip size="small" label={status.active ? `APN: ${status.active_apn || '—'} 已激活` : '未激活'} sx={status.active ? theme=>({bgcolor:theme.palette.mode==='dark' ? theme.palette.success.dark : theme.palette.success.main,color:'#fff'}) : undefined} /> : <CircularProgress size={16} aria-label="读取APN" />}
      {status?.active && <Chip size="small" variant="outlined" label={`协议: ${{ IP: 'IPv4', IPV6: 'IPv6', IPV4V6: 'IPv4/IPv6' }[status.active_protocol?.toUpperCase() || ''] || status.active_protocol || '—'}`} />}
    </Stack>
    <Divider />
    {notice && <Alert severity={notice.severity} onClose={() => setNotice(undefined)}>{notice.text}</Alert>}
    {form && <>
      <TextField ref={selectField} select label="选择 APN" value={choice} fullWidth disabled={saving || deleting} SelectProps={{autoWidth:true,open:listOpen,onOpen:()=>{setListOpen(true);setDeleteConfirmation(undefined)},onClose:()=>{setListOpen(false);setDeleteConfirmation(undefined)},
        renderValue:value=>{const item=status?.choices?.find(row=>row.id===value);return item ? choiceText(item) : manualLabel},
        displayEmpty:true,MenuProps:{slotProps:{paper:{sx:{minWidth:`min(${selectField.current?.clientWidth || 0}px, calc(100vw - 32px))`,maxWidth:'calc(100vw - 32px)'}}}}}} slotProps={{inputLabel:{shrink:true}}} onChange={event=>{
        const selected=status?.choices?.find(item=>item.id===event.target.value)
        setDeleteConfirmation(undefined)
        dirty.current=true; setManual(!selected)
        if (selected) setForm({...selected.settings})
      }} helperText="选择后点击保存APN生效">
        <MenuItem value="">{manualLabel}</MenuItem>
        {(['custom','database'] as const).flatMap(source=>{
          const options=status?.choices?.filter(item=>source==='custom' ? item.source==='custom' : item.source!=='custom') || []
          return options.length ? [<ListSubheader key={source} data-apn-source={source} sx={theme=>{const tint=alpha(theme.palette[source==='custom' ? 'info' : 'success'].main,theme.palette.mode==='dark' ? 0.15 : 0.08);return {bgcolor:'background.paper',backgroundImage:`linear-gradient(${tint}, ${tint})`,color:'text.primary',fontWeight:600,lineHeight:'36px'}}}>{source==='custom' ? '来自修改' : '来自数据库'}</ListSubheader>,...options.map(item=>{
            const confirming=deleteConfirmation?.iccid===status?.iccid && same(item.settings,deleteConfirmation?.settings)
            return <MenuItem key={item.id} value={item.id} sx={{display:'flex',gap:1,flexWrap:'wrap',whiteSpace:'normal'}}>
              <Box sx={{flex:'1 1 120px',minWidth:0,overflowWrap:'anywhere'}}>{choiceText(item)}</Box>
              {item.source==='custom' && <Button size="small" variant="contained" color="error" data-delete-apn={item.settings.apn} aria-label={confirming ? '确认删除个人APN设置' : `删除个人APN ${item.settings.apn} ${protocols[item.settings.pdptype]}`} disabled={!permitted || !status?.iccid || saving || deleting} sx={{ml:'auto',borderRadius:999,minWidth:0,px:1.25,py:0.25,fontSize:'0.75rem',lineHeight:1.75,color:'#fff',boxShadow:'none',flexShrink:0}} onMouseDown={event=>event.stopPropagation()} onKeyDown={event=>{if(event.key==='Enter' || event.key===' ')event.stopPropagation()}} onClick={event=>{event.stopPropagation();void remove(item)}}>{deleting && confirming ? <CircularProgress size={14} color="inherit" /> : confirming ? '确认删除个人APN设置' : '删除'}</Button>}
            </MenuItem>
          })] : []
        })}
      </TextField>
      <TextField label="APN 名称" value={form.apn} fullWidth disabled={saving || deleting} onChange={event => update('apn', event.target.value)} helperText="运营商提供的接入点名称" />
      <TextField select label="IP 协议" value={form.pdptype} fullWidth disabled={saving || deleting} onChange={event => update('pdptype', event.target.value)}><MenuItem value="ipv4">IPv4</MenuItem><MenuItem value="ipv6">IPv6</MenuItem><MenuItem value="ipv4v6">IPv4v6（双栈）</MenuItem></TextField>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
        <TextField label="用户名" value={form.username} fullWidth disabled={saving || deleting} onChange={event => update('username', event.target.value)} placeholder="可选" autoComplete="off" />
        <TextField label="密码" type="password" value={form.password} fullWidth disabled={saving || deleting} onChange={event => update('password', event.target.value)} placeholder="可选" autoComplete="new-password" />
      </Box>
      <TextField select label="认证方式" value={form.auth} fullWidth disabled={saving || deleting} onChange={event => update('auth', event.target.value)}><MenuItem value="none">无</MenuItem><MenuItem value="pap">PAP</MenuItem><MenuItem value="chap">CHAP</MenuItem><MenuItem value="both">PAP / CHAP</MenuItem></TextField>
      <Button variant="contained" size="large" disabled={!writable || saving || deleting || !form.apn} onClick={() => void save()} startIcon={saving ? <CircularProgress size={18} /> : undefined}>保存APN</Button>
    </>}
    {!!status?.logs?.length && <Box data-apn-logs><Typography variant="subtitle2" mb={1}>拨号日志</Typography><Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', fontSize: '0.8rem' }}>{status.logs.join('\n')}</Box></Box>}
  </Stack></CardContent></Card>
}
