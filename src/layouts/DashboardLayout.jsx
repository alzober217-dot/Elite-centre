import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import MobileTabBar from '../components/MobileTabBar.jsx'
import Footer from '../components/Footer.jsx'
import NavigationIcon from '../components/NavigationIcon.jsx'
import { logoutStudent } from '../services/database.js'
import { getNotifications } from '../services/database.js'
import { areAppNotificationsEnabled, notificationPreferencesChangedEventName, notifyAboutNewStudentNotifications } from '../services/appNotifications.js'
import { useLocale } from '../contexts/LocaleContext.jsx'

const links = [
  ['feed', 'موجز الطلاب', 'news'],
  ['announcements', 'إعلانات الإدارة', 'gallery'],
  ['marks', 'علاماتي', 'courses'],
  ['saved', 'المنشورات المحفوظة', 'favorites'],
  ['profile', 'الملف الشخصي', 'profile'],
  ['courses', 'المواد الرقمية', 'courses'],
  ['requests', 'طلباتي', 'requests'],
  ['favorites', 'المفضلة', 'favorites'],
  ['teachers', 'المعلمون', 'teachers'],
  ['gallery', 'المعرض', 'gallery'],
  ['settings', 'الإعدادات', 'settings'],
]

export default function DashboardLayout({ student }) {
  const [logoutError, setLogoutError] = useState('')
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [notificationPreferenceRevision, setNotificationPreferenceRevision] = useState(0)
  const navigate = useNavigate()
  const { t } = useLocale()

  useEffect(() => {
    const onPreferenceChange = () => setNotificationPreferenceRevision((revision) => revision + 1)
    const eventName = notificationPreferencesChangedEventName()
    window.addEventListener(eventName, onPreferenceChange)
    return () => window.removeEventListener(eventName, onPreferenceChange)
  }, [])

  useEffect(() => {
    if (!areAppNotificationsEnabled()) return undefined

    let isCurrent = true
    let isChecking = false
    const checkNotifications = async () => {
      if (isChecking || !isCurrent) return
      isChecking = true
      try {
        const result = await getNotifications()
        if (isCurrent) await notifyAboutNewStudentNotifications(result.items)
      } catch (error) {
        console.error('Could not check for student notifications:', error)
      } finally {
        isChecking = false
      }
    }

    void checkNotifications()
    const timer = window.setInterval(checkNotifications, 60_000)
    return () => {
      isCurrent = false
      window.clearInterval(timer)
    }
  }, [notificationPreferenceRevision])

  async function handleLogout() {
    setIsLoggingOut(true)
    setLogoutError('')
    try {
      await logoutStudent()
      navigate('/login', { replace: true })
    } catch (error) {
      setLogoutError(error.message)
    } finally {
      setIsLoggingOut(false)
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">{t('تجاوز إلى المحتوى')}</a>
      <div className="dashboard-shell">
        <aside className="dashboard-sidebar">
          <Link className="brand" to="/" aria-label={`${t('مركز النخبة')}, ${t('الرئيسية')}`}>
            <img className="brand-image" src="/elite-logo.webp" alt="" />
            <span><strong>{t('مركز النخبة')}</strong><small>{t('مساحة الطالب')}</small></span>
          </Link>
          <nav aria-label={t('قائمة لوحة التحكم')}>
            {links.map(([to, label, icon]) => (
              <NavLink key={to} to={`/dashboard/${to}`} end={to === 'profile'}>
                <NavigationIcon name={icon} /><span>{t(label)}</span>
              </NavLink>
            ))}
          </nav>
          <Link className="sidebar-exit" to="/">{t('العودة للموقع')} <span aria-hidden="true">↗</span></Link>
        </aside>
        <main id="main-content" className="dashboard-main" tabIndex="-1">
          <div className="dashboard-topline">
            <span>{t('بوابة الطالب')}</span>
            <span className="student-chip"><span className="status-dot" /> {t('أهلاً،')} {student?.studentName ?? (t('الطالب'))}{student?.grade ? ` · ${student.grade}` : ''}</span>
            <button className="text-link" type="button" onClick={handleLogout} disabled={isLoggingOut}>{t(isLoggingOut ? 'جارٍ تسجيل الخروج...' : 'تسجيل الخروج')}</button>
          </div>
          {logoutError && <p className="form-message" role="alert">{logoutError}</p>}
          <Outlet />
          <Footer />
        </main>
      </div>
      <MobileTabBar mode="dashboard" />
    </>
  )
}