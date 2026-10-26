import { Capacitor } from '@capacitor/core'

const enabledKey = 'elite-center:app-notifications'
const seenKey = 'elite-center:seen-notifications'
const preferencesChangedEvent = 'elite-center:notification-preferences-changed'

function readSeenNotificationIds() {
  try {
    const value = JSON.parse(window.localStorage.getItem(seenKey) ?? '[]')
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeSeenNotificationIds(ids) {
  try {
    window.localStorage.setItem(seenKey, JSON.stringify(ids.slice(-100)))
  } catch {
    throw new Error('تعذر حفظ حالة الإشعارات على هذا الجهاز.')
  }
}

async function getNativeNotifications() {
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  return LocalNotifications
}

export function areAppNotificationsEnabled() {
  try {
    return window.localStorage.getItem(enabledKey) === 'true'
  } catch {
    return false
  }
}

export function notificationPreferencesChangedEventName() {
  return preferencesChangedEvent
}

export async function getAppNotificationPermission() {
  if (Capacitor.isNativePlatform()) {
    const notifications = await getNativeNotifications()
    const result = await notifications.checkPermissions()
    return result.display
  }
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export async function setAppNotificationsEnabled(enabled) {
  if (!enabled) {
    try {
      window.localStorage.setItem(enabledKey, 'false')
      window.dispatchEvent(new Event(preferencesChangedEvent))
      return 'granted'
    } catch {
      throw new Error('تعذر حفظ إعداد الإشعارات على هذا الجهاز.')
    }
  }

  let permission
  if (Capacitor.isNativePlatform()) {
    const notifications = await getNativeNotifications()
    const current = await notifications.checkPermissions()
    permission = current.display === 'granted' ? current.display : (await notifications.requestPermissions()).display
    if (permission === 'granted' && Capacitor.getPlatform() === 'android') {
      await notifications.createChannel({
        id: 'elite-center-updates',
        name: 'تنبيهات مركز النخبة',
        description: 'إعلانات وتحديثات الطالب من مركز النخبة',
        importance: 4,
        visibility: 1,
      })
    }
  } else if (typeof Notification !== 'undefined' && window.isSecureContext) {
    permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
  } else {
    permission = typeof Notification === 'undefined' ? 'unsupported' : 'insecure-context'
  }

  if (permission !== 'granted') return permission
  try {
    window.localStorage.setItem(enabledKey, 'true')
    window.dispatchEvent(new Event(preferencesChangedEvent))
    return permission
  } catch {
    throw new Error('تعذر حفظ إعداد الإشعارات على هذا الجهاز.')
  }
}

function createNotificationId(value) {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export async function notifyAboutNewStudentNotifications(items) {
  const knownIds = new Set(readSeenNotificationIds())
  const firstCheck = (() => {
    try {
      return window.localStorage.getItem(seenKey) === null
    } catch {
      return true
    }
  })()
  const unseen = items.filter((item) => !knownIds.has(item.id) && !item.isRead)
  writeSeenNotificationIds(items.map((item) => item.id))
  if (firstCheck || !areAppNotificationsEnabled()) return

  if (Capacitor.isNativePlatform()) {
    const notifications = await getNativeNotifications()
    const permission = await notifications.checkPermissions()
    if (permission.display !== 'granted') return
    await notifications.schedule({
      notifications: unseen.slice(0, 3).map((item) => ({
        id: createNotificationId(item.id),
        title: 'مركز النخبة',
        body: item.text,
        channelId: 'elite-center-updates',
        schedule: { at: new Date(Date.now() + 1000) },
        extra: { url: '/dashboard/announcements' },
      })),
    })
    return
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  for (const item of unseen.slice(0, 3)) {
    new Notification('مركز النخبة', { body: item.text, tag: `elite-notification-${item.id}` })
  }
}
