/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-11-23 01:05:03
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:43:58
 * @Description: 
 * 
 * Copyright (c) 2025 by 1orz, All Rights Reserved. 
 */
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { ThemeProvider as MuiThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'

type ThemeMode = 'light' | 'dark'
type ThemePreference = ThemeMode | 'auto'

function luciMode(): ThemeMode {
  try {
    const parent = window.parent.document
    const declared = parent.documentElement.getAttribute('data-darkmode')
    if (declared === 'true' || declared === 'false') return declared === 'true' ? 'dark' : 'light'
    const scheme = window.parent.getComputedStyle(parent.documentElement).colorScheme
    if (scheme === 'dark' || scheme === 'light') return scheme
  } catch { /* Standalone or cross-origin embedding follows the system. */ }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function luciAppearance() {
  const mode = luciMode()
  try {
    // Find the painted surface behind the iframe instead of relying on its
    // transparent canvas, which browsers may render white across color schemes.
    let surface = window.frameElement?.parentElement
    while (surface) {
      const background = window.parent.getComputedStyle(surface).backgroundColor
      if (background !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(background)) return { mode, background }
      surface = surface.parentElement
    }
  } catch { /* Cross-origin embedding uses the resolved mode's default surface. */ }
  return { mode, background: mode === 'dark' ? '#121212' : '#ffffff' }
}

interface ThemeContextType {
  mode: ThemeMode
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}

interface ThemeProviderProps {
  children: ReactNode
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    // The legacy theme-mode key was written even without a user choice.
    const saved = localStorage.getItem('cpe-theme-preference')
    return saved === 'dark' || saved === 'light' ? saved : 'auto'
  })
  const [automaticTheme, setAutomaticTheme] = useState(luciAppearance)
  const mode = preference === 'auto' ? automaticTheme.mode : preference
  const embedded = new URLSearchParams(location.search).has('embedded')
  const surfaceColor = preference === 'auto' ? automaticTheme.background : mode === 'dark' ? '#121212' : '#ffffff'

  useEffect(() => {
    localStorage.setItem('cpe-theme-preference', preference)
  }, [preference])
  useEffect(() => {
    const update = () => {
      const appearance = luciAppearance()
      setAutomaticTheme(previous => previous.mode === appearance.mode && previous.background === appearance.background ? previous : appearance)
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    const observer = new MutationObserver(update)
    try {
      const parent = window.parent.document
      observer.observe(parent.documentElement, { attributes: true })
      if (parent.body) observer.observe(parent.body, { attributes: true })
    } catch { /* Parent DOM access is optional. */ }
    update()
    return () => { observer.disconnect(); media.removeEventListener('change', update) }
  }, [])
  useEffect(() => {
    if (!embedded) return
    const frame = window.frameElement as HTMLElement | null
    if (!frame) return
    const previousScheme = frame.style.colorScheme, previousBackground = frame.style.backgroundColor
    frame.style.colorScheme = mode
    frame.style.backgroundColor = surfaceColor
    return () => { frame.style.colorScheme = previousScheme; frame.style.backgroundColor = previousBackground }
  }, [embedded, mode, surfaceColor])

  const theme = createTheme({
    palette: {
      mode,
      primary: {
        main: mode === 'light' ? '#1976d2' : '#90caf9',
        light: mode === 'light' ? '#42a5f5' : '#e3f2fd',
        dark: mode === 'light' ? '#1565c0' : '#42a5f5',
      },
      secondary: {
        main: mode === 'light' ? '#dc004e' : '#f48fb1',
        light: mode === 'light' ? '#f50057' : '#f8bbd0',
        dark: mode === 'light' ? '#c51162' : '#ec407a',
      },
      success: {
        main: mode === 'light' ? '#2e7d32' : '#66bb6a',
        light: mode === 'light' ? '#4caf50' : '#81c784',
        dark: mode === 'light' ? '#1b5e20' : '#388e3c',
      },
      warning: {
        main: mode === 'light' ? '#ed6c02' : '#ffa726',
        light: mode === 'light' ? '#ff9800' : '#ffb74d',
        dark: mode === 'light' ? '#e65100' : '#f57c00',
      },
      error: {
        main: mode === 'light' ? '#d32f2f' : '#f44336',
        light: mode === 'light' ? '#ef5350' : '#e57373',
        dark: mode === 'light' ? '#c62828' : '#d32f2f',
      },
      info: {
        main: mode === 'light' ? '#0288d1' : '#29b6f6',
        light: mode === 'light' ? '#03a9f4' : '#4fc3f7',
        dark: mode === 'light' ? '#01579b' : '#0277bd',
      },
      background: {
        default: mode === 'light' ? '#f5f5f5' : '#121212',
        paper: mode === 'light' ? '#ffffff' : '#1e1e1e',
      },
    },
    typography: {
      fontFamily: [
        '-apple-system',
        'BlinkMacSystemFont',
        '"Segoe UI"',
        'Roboto',
        '"Helvetica Neue"',
        'Arial',
        'sans-serif',
        '"Apple Color Emoji"',
        '"Segoe UI Emoji"',
        '"Segoe UI Symbol"',
      ].join(','),
      h4: {
        fontWeight: 600,
      },
      h5: {
        fontWeight: 600,
      },
      h6: {
        fontWeight: 600,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: {
            colorScheme: mode,
            backgroundColor: embedded ? surfaceColor : undefined,
          },
          body: {
            backgroundColor: embedded ? surfaceColor : undefined,
            colorScheme: mode,
            scrollbarColor: mode === 'dark' ? '#6b6b6b #2b2b2b' : '#c1c1c1 #f1f1f1',
            '&::-webkit-scrollbar, & *::-webkit-scrollbar': {
              width: 8,
              height: 8,
            },
            '&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb': {
              borderRadius: 4,
              backgroundColor: mode === 'dark' ? '#6b6b6b' : '#c1c1c1',
            },
            '&::-webkit-scrollbar-track, & *::-webkit-scrollbar-track': {
              backgroundColor: mode === 'dark' ? '#2b2b2b' : '#f1f1f1',
            },
          },
        },
      },
      MuiCard: {
        defaultProps: {
          elevation: 0,
        },
        styleOverrides: {
          root: {
            borderRadius: 12,
            boxShadow: 'none',
            backgroundImage: 'none',
            backgroundColor: mode === 'light' ? '#fbfbfb' : '#1e1e1e',
            border: `1px solid ${mode === 'light' ? '#e5e5e5' : '#383838'}`,
          },
        },
      },
      MuiButton: {
        defaultProps: {
          disableElevation: true,
        },
        styleOverrides: {
          root: {
            borderRadius: 8,
            textTransform: 'none',
            fontWeight: 500,
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            borderRadius: 12,
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            borderRadius: 0,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            fontWeight: 500,
          },
        },
      },
    },
    shape: {
      borderRadius: 8,
    },
  })

  return (
    <ThemeContext.Provider value={{ mode, preference, setPreference }}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  )
}

