import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import {
  getCatalogSnapshot,
  hasStudentAccess,
  verifyStudentSession,
} from '../services/database.js'

import NavigationIcon from './NavigationIcon.jsx'
import { useLocale } from '../contexts/LocaleContext.jsx'

const links = [
  {
    to: '/',
    label: 'الرئيسية',
    icon: 'home',
  },
  {
    to: '/courses',
    label: 'المواد',
    icon: 'courses',
  },
  {
    to: '/teachers',
    label: 'المعلمون',
    icon: 'teachers',
  },
  {
    to: '/#grades',
    label: 'الأخبار',
    icon: 'news',
  },
  {
    to: '/dashboard/feed',
    label: 'مساحة الطالب',
    icon: 'profile',
  },
]

function isCurrentLink(to, pathname, hash) {
  const [path, targetHash] = to.split('#')
  const routePath = path || '/'

  if (targetHash) {
    return (
      pathname === routePath &&
      hash === `#${targetHash}`
    )
  }

  if (routePath.startsWith('/dashboard/')) {
    return pathname.startsWith('/dashboard')
  }

  if (routePath === '/') {
    return pathname === '/' && hash === ''
  }

  return (
    pathname === routePath ||
    pathname.startsWith(`${routePath}/`)
  )
}

export default function Header() {
  const [settings, setSettings] = useState({})

  const [studentSession, setStudentSession] = useState(
    () => (hasStudentAccess() ? 'active' : 'checking'),
  )

  const { pathname, hash } = useLocation()
  const { t } = useLocale()

  useEffect(() => {
    let isCurrent = true

    getCatalogSnapshot()
      .then((snapshot) => {
        if (isCurrent) {
          setSettings(snapshot?.catalog?.settings ?? {})
        }
      })
      .catch((error) => {
        console.error(
          'Failed to load center settings:',
          error,
        )
      })

    return () => {
      isCurrent = false
    }
  }, [])

  useEffect(() => {
    let isCurrent = true

    verifyStudentSession()
      .then((student) => {
        if (isCurrent) {
          setStudentSession(student ? 'active' : 'guest')
        }
      })
      .catch((error) => {
        console.error(
          'Failed to verify student session:',
          error,
        )

        if (isCurrent) {
          setStudentSession((current) =>
            current === 'active' ? current : 'guest',
          )
        }
      })

    return () => {
      isCurrent = false
    }
  }, [pathname])

  const centerName =
    settings.centerName ?? 'مركز النخبة'

  const tagline =
    settings.tagline ?? 'للتعلّم والإبداع'

  return (
    <header className="site-header">
      <Link
        className="brand"
        to="/"
        aria-label={`${t(centerName)}, ${t('الرئيسية')}`}
      >
        <img
          className="brand-image"
          src={settings.logoPath || '/elite-logo.webp'}
          alt=""
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
        />

        <span>
          <strong>{t(centerName)}</strong>
          <small>{t(tagline)}</small>
        </span>
      </Link>

      <nav
        className="main-nav"
        aria-label={t('التنقل الرئيسي')}
      >
        {links.map((link) => {
          const active = isCurrentLink(
            link.to,
            pathname,
            hash,
          )

          return (
            <Link
              key={link.to}
              to={link.to}
              className={active ? 'active' : undefined}
              aria-current={active ? 'page' : undefined}
            >
              <NavigationIcon name={link.icon} />

              <span>{t(link.label)}</span>
            </Link>
          )
        })}
      </nav>

      <div className="header-auth">
        {studentSession === 'active' ? (
          <Link
            className="button button-dark header-action"
            to="/dashboard/feed"
          >
            {t('مساحة الطالب')}
          </Link>
        ) : studentSession === 'guest' ? (
          <>
            <Link
              className="button button-light header-register"
              to="/register"
            >
              {t('طلب تسجيل')}
            </Link>

            <Link
              className="button button-dark header-action"
              to="/login"
            >
              {t('دخول الطالب')}
            </Link>
          </>
        ) : null}
      </div>
    </header>
  )
}
