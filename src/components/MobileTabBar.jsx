import { Link, useLocation } from 'react-router-dom'
import NavigationIcon from './NavigationIcon.jsx'
import { useLocale } from '../contexts/LocaleContext.jsx'

const publicItems = [
  { to: '/', label: 'الرئيسية', icon: 'home' },
  { to: '/#grades', label: 'الأخبار', icon: 'news' },
  { to: '/courses', label: 'المواد', icon: 'courses' },
  { to: '/teachers', label: 'المعلمون', icon: 'teachers' },
  { to: '/login', label: 'حسابي', icon: 'profile' },
]

const dashboardItems = [
  { to: '/', label: 'الرئيسية', icon: 'home' },
  {
    to: '/dashboard/profile',
    label: 'ملفي',
    icon: 'profile',
  },
  {
    to: '/dashboard/feed',
    label: 'الموجز',
    icon: 'news',
  },
  {
    to: '/dashboard/announcements',
    label: 'إعلانات',
    icon: 'gallery',
  },
  {
    to: '/dashboard/marks',
    label: 'علاماتي',
    icon: 'courses',
  },
  {
    to: '/dashboard/saved',
    label: 'محفوظات',
    icon: 'favorites',
  },
]

function tabIsActive(item, pathname, hash) {
  if (item.to === '/login') {
    return (
      ['/login', '/register'].includes(pathname) ||
      pathname.startsWith('/dashboard')
    )
  }

  const [route, routeHash] = item.to.split('#')
  const routePath = route || '/'

  if (routeHash) {
    return (
      pathname === routePath &&
      hash === `#${routeHash}`
    )
  }

  if (routePath === '/') {
    return pathname === '/' && hash === ''
  }

  return (
    pathname === routePath ||
    pathname.startsWith(`${routePath}/`)
  )
}

export default function MobileTabBar({
  mode = 'public',
}) {
  const { pathname, hash } = useLocation()
  const { t } = useLocale()

  const isDashboard = mode === 'dashboard'

  const items = isDashboard
    ? dashboardItems
    : publicItems

  return (
    <nav
      className={`mobile-tab-bar ${
        isDashboard ? 'dashboard' : 'public'
      }`}
      aria-label={t(
        isDashboard
          ? 'تنقل مساحة الطالب'
          : 'التنقل الرئيسي',
      )}
    >
      {items.map((item) => {
        const isActive = tabIsActive(
          item,
          pathname,
          hash,
        )

        return (
          <Link
            className={`mobile-tab${
              isActive ? ' active' : ''
            }`}
            to={item.to}
            key={item.to}
            aria-current={
              isActive ? 'page' : undefined
            }
          >
            <NavigationIcon name={item.icon} />

            <span>{t(item.label)}</span>
          </Link>
        )
      })}
    </nav>
  )
}
