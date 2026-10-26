import { useMemo, useState } from 'react'
import usePageTitle from '../../hooks/usePageTitle.js'
import useAsyncData from '../../hooks/useAsyncData.js'
import { getAnnouncements, getNotifications, markNotificationRead } from '../../services/database.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'
import { ErrorState, LoadingState } from '../../components/PageState.jsx'

async function loadAll() {
  const [announcementResult, notificationResult] = await Promise.all([getAnnouncements(), getNotifications()])
  return { announcements: announcementResult.items, notifications: notificationResult.items }
}

export default function Announcements() {
  const { language, t } = useLocale()
  const { data, error, isLoading, reload } = useAsyncData('announcements', loadAll)
  const [readIds, setReadIds] = useState(() => new Set())
  const [markError, setMarkError] = useState('')
  const [pendingId, setPendingId] = useState('')
  usePageTitle('إعلانات الإدارة')

  const formatDate = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })
    return (value) => formatter.format(new Date(value))
  }, [language])

  const { announcements, otherNotifications, notificationByAnnouncement } = useMemo(() => {
    const notifications = data?.notifications ?? []
    return {
      announcements: data?.announcements ?? [],
      otherNotifications: notifications.filter((item) => item.type !== 'announcement'),
      notificationByAnnouncement: new Map(notifications.filter((item) => item.type === 'announcement').map((item) => [item.referenceId, item])),
    }
  }, [data])

  async function markRead(notificationId) {
    if (pendingId) return
    setMarkError('')
    setPendingId(notificationId)
    try {
      await markNotificationRead(notificationId)
      setReadIds((current) => new Set(current).add(notificationId))
    } catch (markReadError) {
      setMarkError(markReadError.message)
    } finally {
      setPendingId('')
    }
  }

  return (
    <section className="dashboard-page">
      <span className="eyebrow">{t('إشعارات مساحة الطالب')}</span>
      <h1 className="page-title">{t('إعلانات الإدارة')}</h1>
      <p className="page-intro">{t('الإعلانات الرسمية منفصلة عن أخبار الموقع، وتصل تلقائياً لكل طالب نشط.')}</p>
      {markError && <p className="form-message" role="alert">{t(markError)}</p>}
      {isLoading && !data ? <LoadingState label="جارٍ تحميل الإعلانات..." />
        : error ? <ErrorState message={error} onRetry={reload} />
          : <>
            {announcements.length ? <div className="announcement-list">
              {announcements.map((item) => {
                const notification = notificationByAnnouncement.get(item.id)
                const isRead = item.isRead || (notification && readIds.has(notification.id))
                return (
                  <article className={`admin-announcement${isRead ? '' : ' unread'}`} key={item.id}>
                    <div className="announcement-status">{t(isRead ? 'مقروء' : 'جديد')}</div>
                    <p>{t(item.text)}</p>
                    <small>{formatDate(item.createdAt)}</small>
                    {!isRead && notification && <button className="text-link" type="button" disabled={pendingId === notification.id} onClick={() => markRead(notification.id)}>{t('تحديد كمقروء')}</button>}
                  </article>
                )
              })}
            </div> : <div className="empty-state"><h2>{t('لا توجد إعلانات حالياً')}</h2><p>{t('ستظهر هنا إعلانات إدارة المركز عند نشرها.')}</p></div>}
            {otherNotifications.length > 0 && <section className="student-notification-list">
              <h2>{t('إشعارات أخرى')}</h2>
              {otherNotifications.map((item) => {
                const isRead = item.isRead || readIds.has(item.id)
                return (
                  <article key={item.id} className={isRead ? '' : 'unread'}>
                    <p>{t(item.text)}</p><small>{formatDate(item.createdAt)}</small>
                    {!isRead && <button className="text-link" type="button" disabled={pendingId === item.id} onClick={() => markRead(item.id)}>{t('تحديد كمقروء')}</button>}
                  </article>
                )
              })}
            </section>}
          </>}
    </section>
  )
}

