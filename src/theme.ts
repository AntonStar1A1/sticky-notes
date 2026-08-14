// 主题系统(spec 7.14 外观设置):
// 5 种预设 + 自定义颜色,通过 CSS 变量注入;localStorage 持久化,同源多窗口共享。
export type ThemeName = 'dark' | 'light' | 'blue' | 'purple' | 'yellow' | 'custom'

const KEY = 'sticky-theme'

interface Vars {
  bg: string
  bgGlass: string
  bgSolid: string
  bgHover: string
  bgActive: string
  fg: string
  fgDim: string
  fgFaint: string
  accent: string
  border: string
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

// spec 7.14 色彩系统(1449-1461)与主题预设(1006-1013):
// 暗色 bg rgba(20,20,25,0.85)/#E8E8E8/#A0A0A0/#666666/品牌色 #4C9EEB;
// 亮色 rgba(255,255,255,0.95)、淡蓝 rgba(200,220,240,0.9)、淡紫 rgba(220,200,240,0.9)、淡黄 rgba(240,230,200,0.9)
const PRESETS: Record<Exclude<ThemeName, 'custom'>, Vars> = {
  dark: {
    bg: 'rgba(20,20,25,0.85)',
    bgGlass: 'rgba(20,20,25,0.5)',
    bgSolid: '#141419',
    bgHover: 'rgba(255,255,255,0.04)',
    bgActive: 'rgba(255,255,255,0.06)',
    fg: '#E8E8E8',
    fgDim: '#A0A0A0',
    fgFaint: '#666666',
    accent: '#4C9EEB',
    border: 'rgba(255,255,255,0.08)',
  },
  light: {
    bg: 'rgba(255,255,255,0.95)',
    bgGlass: 'rgba(255,255,255,0.75)',
    bgSolid: '#ffffff',
    bgHover: 'rgba(0,0,0,0.05)',
    bgActive: 'rgba(0,0,0,0.09)',
    fg: '#1a1a20',
    fgDim: '#5f5f6a',
    fgFaint: '#9a9aa5',
    accent: '#3b5bdb',
    border: 'rgba(0,0,0,0.12)',
  },
  blue: {
    bg: 'rgba(200,220,240,0.9)',
    bgGlass: 'rgba(200,220,240,0.7)',
    bgSolid: '#c8dcf0',
    bgHover: 'rgba(0,60,160,0.07)',
    bgActive: 'rgba(0,60,160,0.12)',
    fg: '#16233a',
    fgDim: '#4a5a75',
    fgFaint: '#8494ad',
    accent: '#2b5fd9',
    border: 'rgba(20,40,90,0.16)',
  },
  purple: {
    bg: 'rgba(220,200,240,0.9)',
    bgGlass: 'rgba(220,200,240,0.7)',
    bgSolid: '#dcc8f0',
    bgHover: 'rgba(90,40,160,0.07)',
    bgActive: 'rgba(90,40,160,0.12)',
    fg: '#2a1a3d',
    fgDim: '#5c4a70',
    fgFaint: '#9384a5',
    accent: '#7c4dff',
    border: 'rgba(70,30,130,0.16)',
  },
  yellow: {
    bg: 'rgba(240,230,200,0.9)',
    bgGlass: 'rgba(240,230,200,0.7)',
    bgSolid: '#f0e6c8',
    bgHover: 'rgba(120,90,0,0.07)',
    bgActive: 'rgba(120,90,0,0.12)',
    fg: '#33290a',
    fgDim: '#6b5c25',
    fgFaint: '#a0935c',
    accent: '#b8860b',
    border: 'rgba(100,75,0,0.18)',
  },
}

export function buildVars(name: ThemeName, customColor: string): Vars {
  if (name === 'custom') {
    const c = customColor || '#4C9EEB'
    const dark = luminance(c) < 0.5
    return {
      bg: hexToRgba(c, 0.88),
      bgGlass: hexToRgba(c, 0.6),
      bgSolid: c,
      bgHover: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
      bgActive: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)',
      fg: dark ? '#ffffff' : '#111111',
      fgDim: dark ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.62)',
      fgFaint: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.4)',
      accent: dark ? '#ffffff' : '#000000',
      border: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)',
    }
  }
  return PRESETS[name]
}

export function applyTheme(name: ThemeName, customColor: string) {
  const v = buildVars(name, customColor)
  const root = document.documentElement
  root.style.setProperty('--bg', v.bg)
  root.style.setProperty('--bg-glass', v.bgGlass)
  root.style.setProperty('--bg-solid', v.bgSolid)
  root.style.setProperty('--bg-hover', v.bgHover)
  root.style.setProperty('--bg-active', v.bgActive)
  root.style.setProperty('--fg', v.fg)
  root.style.setProperty('--fg-dim', v.fgDim)
  root.style.setProperty('--fg-faint', v.fgFaint)
  root.style.setProperty('--accent', v.accent)
  root.style.setProperty('--border', v.border)
}

export function loadTheme() {
  const raw = localStorage.getItem(KEY)
  let name: ThemeName = 'dark'
  let custom = '#4C9EEB'
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.name === 'string') name = parsed.name as ThemeName
      if (parsed && typeof parsed.customColor === 'string') custom = parsed.customColor
    } catch {
      /* 忽略损坏的主题配置,回退默认 */
    }
  }
  applyTheme(name, custom)
  return { name, customColor: custom }
}

export function saveTheme(name: ThemeName, customColor: string) {
  localStorage.setItem(KEY, JSON.stringify({ name, customColor }))
  applyTheme(name, customColor)
}

export const THEME_PRESETS: { name: ThemeName; label: string; color: string }[] = [
  { name: 'dark', label: '暗色', color: 'rgba(20,20,25,0.85)' },
  { name: 'light', label: '亮色', color: '#ffffff' },
  { name: 'blue', label: '淡蓝', color: '#c8dcf0' },
  { name: 'purple', label: '淡紫', color: '#dcc8f0' },
  { name: 'yellow', label: '淡黄', color: '#f0e6c8' },
]
