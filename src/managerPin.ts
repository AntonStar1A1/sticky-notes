// 管理台窗口置顶状态:localStorage 持久化 + 自定义事件广播(与 edgeDock 模式同构)
export const MANAGER_PIN_KEY = 'managerAlwaysOnTop'
export const MANAGER_PIN_EVENT = 'manager-pin-changed'

export function isManagerPinned(): boolean {
  const val = localStorage.getItem(MANAGER_PIN_KEY)
  return val === null ? false : val === 'true'
}

export function setManagerPinned(value: boolean) {
  localStorage.setItem(MANAGER_PIN_KEY, String(value))
}
