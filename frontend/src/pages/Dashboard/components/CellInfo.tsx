/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-12-10 10:21:27
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:44:10
 * @FilePath: /udx710-backend/frontend/src/pages/Dashboard/components/CellInfo.tsx
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { useState, type MouseEvent, type ReactNode } from 'react'
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  IconButton,
  Tooltip,
  Collapse,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  type Theme,
  TableRow,
  Paper,
} from '@mui/material'
import { alpha } from '@/utils/theme'
import { formatCellBandwidth, getCellFrequencyLabel, getCellTechnologyLabel } from '@/utils/cells'
import { CellTower, Visibility, VisibilityOff, ExpandMore, ExpandLess, Info } from '@mui/icons-material'
import { useSensitiveVisibility } from '../../../contexts/revealSensitive'
import { getSensitiveStyle, formatSignalValue, getSignalChipColor } from '../utils'
import type { CellsResponse, CellInfo as Cell } from '@/api/types'

interface CellInfoProps {
  cellsInfo: CellsResponse | null
  stale?: boolean
  renderAction?: (cell: Cell) => ReactNode
  headerAction?: ReactNode
  showPlmn?: boolean
}

export function CellInfo({ cellsInfo, stale = false, renderAction, showPlmn = false, headerAction }: CellInfoProps) {
  const [expanded, setExpanded] = useState(true)
  const [showInfo, setShowInfo] = useSensitiveVisibility()

  return (
    <Card data-cell-snapshot>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 1.5,
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover' },
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" sx={{ minWidth: 0 }}>
          <Box display="flex" alignItems="center" gap={1}>
            <CellTower fontSize="small" color="primary" />
            <Typography variant="subtitle2" fontWeight="medium" sx={{ whiteSpace: 'nowrap' }}>
              小区信息
            </Typography>
          </Box>
          {cellsInfo?.serving_cell && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 0.75,
                ...getSensitiveStyle(showInfo),
              }}
            >
              <Chip data-cell-technology label={getCellTechnologyLabel(cellsInfo)} size="small" color="primary" />
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                CID: <strong>{cellsInfo.serving_cell.cell_id}</strong>
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                TAC: <strong>{cellsInfo.serving_cell.tac}</strong>
              </Typography>
            </Box>
          )}
          {stale && cellsInfo && <Chip label="上次结果" size="small" variant="outlined" />}
          <Tooltip title={showInfo ? '隐藏敏感信息' : '显示完整信息'}>
            <IconButton
              size="small"
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                setShowInfo(!showInfo)
              }}
            >
              {showInfo ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
        <Box display="flex" alignItems="center" gap={0.5} sx={{ flexShrink: 0 }}>
          <Box onClick={event => event.stopPropagation()}>{headerAction}</Box>
          {cellsInfo?.cells && <Chip label={`${cellsInfo.cells.length}`} size="small" color="primary" variant="outlined" />}
          <IconButton size="small">{expanded ? <ExpandLess /> : <ExpandMore />}</IconButton>
        </Box>
      </Box>
      <Collapse in={expanded}>
        <CardContent sx={{ pt: 0, px: { xs: 1, sm: 2 } }}>
          <TableContainer component={Paper} variant="outlined" sx={(theme) => ({
            maxHeight: 300,
            ...(theme.palette.mode === 'light' ? {
              bgcolor: '#ffffff',
              '& .MuiTableCell-head': { bgcolor: '#ffffff' },
            } : {}),
          })}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ minWidth: 50, py: 0.5, px: 1, fontSize: '0.7rem' }}>频段</TableCell>
                  {showPlmn && <TableCell sx={{ py: 0.5, px: 0.5, fontSize: '0.7rem' }}>PLMN</TableCell>}
                  <TableCell align="right" sx={{ minWidth: 65, py: 0.5, px: 0.5, fontSize: '0.7rem' }}>Bandwidth</TableCell>
                  <TableCell align="right" sx={{ minWidth: 55, py: 0.5, px: 0.5, fontSize: '0.7rem' }}>
                    {getCellFrequencyLabel(cellsInfo)}
                  </TableCell>
                  <TableCell align="right" sx={{ minWidth: 40, py: 0.5, px: 0.5, fontSize: '0.7rem' }}>
                    PCI
                  </TableCell>
                  <TableCell align="right" sx={{ minWidth: 50, py: 0.5, px: 0.5, fontSize: '0.7rem' }}>
                    RSRP
                  </TableCell>
                  <TableCell align="right" sx={{ minWidth: 45, py: 0.5, px: 0.5, fontSize: '0.7rem' }}>
                    RSRQ
                  </TableCell>
                  <TableCell align="right" sx={{ minWidth: 45, py: 0.5, px: 0.5, fontSize: '0.7rem' }}>
                    SINR
                  </TableCell>
                  {renderAction && <TableCell align="right" sx={{ py: 0.5, px: 1, fontSize: '0.7rem', position: 'sticky', right: 0, zIndex: 3 }}>操作</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {cellsInfo?.cells && cellsInfo.cells.length > 0 ? (
                  cellsInfo.cells.map((cell, idx) => (
                    <TableRow
                      key={idx}
                      sx={(theme: Theme) => {
                        const tint = alpha(theme.palette[cell.is_secondary ? 'info' : 'success'].main, theme.palette.mode === 'dark' ? 0.15 : 0.08)
                        return {
                          // An opaque base keeps scrolled content behind the sticky action column hidden.
                          '& > .MuiTableCell-body': {
                            bgcolor: theme.palette.mode === 'light' ? '#ffffff' : 'background.paper',
                            backgroundImage: cell.is_serving ? `linear-gradient(${tint}, ${tint})` : 'none',
                          },
                        }
                      }}
                    >
                      <TableCell sx={{ py: 0.5, px: 1 }}>
                        <Box display="flex" alignItems="center" gap={0.5}>
                          {cell.is_serving && (
                            <Tooltip title={cell.carrier_role || (cell.is_secondary ? 'NR 辅服务小区（PSCell）' : '主服务小区')}>
                              <Box
                                component="span"
                                role="img"
                                aria-label={cell.carrier_role || (cell.is_secondary ? 'NR 辅服务小区' : '主服务小区')}
                                sx={{
                                  display: 'inline-block',
                                  width: 6,
                                  height: 6,
                                  borderRadius: '50%',
                                  bgcolor: cell.is_secondary ? 'info.main' : 'success.main',
                                  flexShrink: 0,
                                }}
                              />
                            </Tooltip>
                          )}
                          <Typography variant="caption" sx={{ fontSize: '0.75rem', fontWeight: cell.is_serving ? 600 : 400 }}>
                            {cell.band && cell.band !== '0' ? cell.band : '-'}
                          </Typography>
                        </Box>
                      </TableCell>
                      {showPlmn && <TableCell sx={{ py: 0.5, px: 0.5, fontSize: '0.7rem', whiteSpace: 'nowrap' }}>{cell.mcc && cell.mnc ? `${cell.mcc}/${cell.mnc}` : '-'}</TableCell>}
                      <TableCell align="right" sx={{ py: 0.5, px: 0.5, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                        <Tooltip title={cell.tech === 'nr' && cell.bandwidth_mhz == null
                          ? '模块暂未返回有效的 NR 带宽'
                          : cell.bandwidth_current === false ? '模块报告的 NR 带宽；当前未处于 RRC 连接态，可能保留自上次连接' : ''}>
                          <span>{formatCellBandwidth(cell.bandwidth_mhz)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, px: 0.5, fontSize: '0.75rem', fontFamily: 'monospace' }}>
                        {cell.arfcn ?? '-'}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, px: 0.5, fontSize: '0.75rem', fontFamily: 'monospace' }}>
                        {cell.pci ?? '-'}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, px: 0.5 }}>
                        {cell.rsrp !== undefined ? (
                          <Chip
                            label={formatSignalValue(cell.rsrp)}
                            size="small"
                            color={getSignalChipColor(cell.rsrp)}
                            sx={{ height: 18, fontSize: '0.65rem', '& .MuiChip-label': { px: 0.5 } }}
                          />
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, px: 0.5, fontSize: '0.7rem', fontFamily: 'monospace' }}>
                        {formatSignalValue(cell.rsrq)}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, px: 0.5, fontSize: '0.7rem', fontFamily: 'monospace' }}>
                        <Tooltip title={cell.sinr == null && cell.rssnr != null ? 'QCAINFO 报告的 RSSNR（dB），不是 QENG SINR；此处作为信噪质量参考' : ''}>
                          <span>{formatSignalValue(cell.sinr ?? cell.rssnr)}</span>
                        </Tooltip>
                      </TableCell>
                      {renderAction && <TableCell align="right" sx={{ py: 0.5, px: 1, whiteSpace: 'nowrap', position: 'sticky', right: 0, zIndex: 1 }}>{renderAction(cell)}</TableCell>}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7 + (renderAction ? 1 : 0) + (showPlmn ? 1 : 0)} align="center">
                      <Box display="flex" alignItems="center" justifyContent="center" gap={1} py={1}>
                        <Info fontSize="small" color="disabled" />
                        <Typography variant="caption" color="text.secondary">
                          暂无小区数据
                        </Typography>
                      </Box>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Collapse>
    </Card>
  )
}
