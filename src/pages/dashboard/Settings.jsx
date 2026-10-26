import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import usePageTitle from '../../hooks/usePageTitle.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'
import { Capacitor } from '@capacitor/core'
import { areAppNotificationsEnabled, getAppNotificationPermission, setAppNotificationsEnabled } from '../../services/appNotifications.js'

export default function Settings() {
  const { language, changeLanguage, t } = useLocale()
  const [notificationsEnabled, setNotificationsEnabled] = useState(areAppNotificationsEnabled)
  const [permission, setPermission] = useState('prompt')
  const [message, setMessage] = useState('')
  const isAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  usePageTitle('الإعدادات')

  useEffect(() => {
    let isCurrent = true
    getAppNotificationPermission().then((nextPermission) => {
      if (isCurrent) setPermission(nextPermission)
    }).catch((error) => {
      if (isCurrent) setMessage(t(error.message))
    })
    return () => { isCurrent = false }
  }, [])

  async function enableNotifications() {
    setMessage('')
    try {
      const nextPermission = await setAppNotificationsEnabled(true)
      setPermission(nextPermission)
      if (nextPermission !== 'granted') {
        setNotificationsEnabled(false)
        setMessage(t(nextPermission === 'denied'
          ? 'الإشعارات محظورة. غيّر الإذن من إعدادات Android للتطبيق.'
          : nextPermission === 'insecure-context'
            ? 'يتطلب إذن الإشعارات اتصالاً آمناً (HTTPS) أو localhost.'
            : nextPermission === 'unsupported'
              ? 'إشعارات التطبيق غير مدعومة على هذا الجهاز.'
              : 'لم يتم منح إذن الإشعارات.'))
        return
      }
      setNotificationsEnabled(true)
      setMessage(t('إشعارات التطبيق مفعّلة. ستصل التنبيهات أثناء استخدام التطبيق.'))
    } catch (error) {
      setMessage(t(error.message))
    }
  }

  async function disableNotifications() {
    setMessage('')
    try {
      await setAppNotificationsEnabled(false)
      setNotificationsEnabled(false)
    } catch (error) {
      setMessage(t(error.message))
    }
  }

  function handleLanguageChange(event) {
    setMessage('')
    try {
      changeLanguage(event.target.value)
    } catch (error) {
      setMessage(t(error.message))
    }
  }

  return (
    <section className="dashboard-page">
      <span className="eyebrow">{t('مساحة الطالب')}</span>
      <h1 className="page-title">{t('الإعدادات')}</h1>
      <p className="page-intro">{t('إدارة تفضيلات الحساب والإشعارات.')}</p>
      <div className="settings-row">
        <div><strong>{t('اللغة')}</strong><span>{t('لغة واجهة العرض')}</span></div>
        <select value={language} onChange={handleLanguageChange} aria-label={t('لغة واجهة العرض')}>
          <option value="ar">{t('العربية')}</option>
          <option value="en">{t('English')}</option>
        </select>
      </div>
      <section className="settings-row settings-row-stack">
        <div><strong>{t('إشعارات التطبيق')}</strong><span>{t('تعمل الإشعارات أثناء فتح التطبيق. يتطلب الإرسال عند إغلاقه إعداد خدمة push خارجية.')}</span></div>
        <div className="settings-action">
          <span role="status">{t(permission === 'granted' ? 'إذن الإشعارات ممنوح.' : permission === 'denied' ? 'الإشعارات محظورة. غيّر الإذن من إعدادات Android للتطبيق.' : permission === 'unsupported' ? 'إشعارات التطبيق غير مدعومة على هذا الجهاز.' : 'لم يتم تفعيل إشعارات التطبيق.')}</span>
          {notificationsEnabled
            ? <button className="button button-light" type="button" onClick={disableNotifications}>{t('إيقاف الإشعارات')}</button>
            : <button className="button button-dark" type="button" onClick={enableNotifications}>{t('تفعيل إشعارات التطبيق')}</button>}
        </div>
      </section>
      {isAndroid && <div className="settings-row"><div><strong>{t('تثبيت تطبيق Android')}</strong><span>{t('نزّل ملف APK من صفحة التنزيل الرسمية لتثبيته على جهازك.')}</span></div></div>}
      <div className="settings-row">
        <div><strong>{t('إعلانات الإدارة')}</strong><span>{t('متابعة التنبيهات الرسمية وحالة قراءتها')}</span></div>
        <Link className="text-link" to="/dashboard/announcements">{t('عرض الإعلانات')}</Link>
      </div>
      {message && <p className="form-message" role="status">{message}</p>}
    </section>
  )
}
