import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle.js'
import { getCatalogSnapshot, getNews, hasStudentAccess, verifyStudentSession, toggleNewsReaction } from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'

/* ------------------------------------------------------------------ */
/* الثوابت                                                             */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  centerName: 'مركز النخبة',
  homeTitle: 'اختر صفّك الدراسي',
  homeSubtitle: 'مواد تعليمية ومدرسون متخصصون، بخيارات وأسعار واضحة.',
  logoPath: '/elite-logo.webp',
}

// الصفوف التي رقمها أكبر من هذه القيمة تعرض أيقونة التخرج بدل الرقم
const GRADUATE_CAP_AFTER_GRADE_ID = 11

const GRADES_HASH = '#grades'

const CATALOG_STATUS_LABELS = {
  live: 'البيانات محدثة من إدارة المركز',
  demo: 'بيانات العرض المحلية',
}
const CATALOG_STATUS_LOADING = 'جارٍ تحميل بيانات المركز'

/* ------------------------------------------------------------------ */
/* أدوات مساعدة                                                        */
/* ------------------------------------------------------------------ */

// يقبل روابط http/https فقط، حتى لا يصل رابط خبيث (javascript: مثلاً) من البيانات إلى href
function toSafeHref(value) {
  if (typeof value !== 'string') return null
  const href = value.trim()
  if (!href) return null
  try {
    const { protocol } = new URL(href, window.location.origin)
    return protocol === 'http:' || protocol === 'https:' ? href : null
  } catch {
    return null
  }
}

function useNumberFormatter() {
  const { language } = useLocale()
  return useMemo(() => {
    const formatter = new Intl.NumberFormat(language)
    return (value) => formatter.format(value)
  }, [language])
}

/* ------------------------------------------------------------------ */
/* الـ Hooks (منطق البيانات)                                            */
/* ------------------------------------------------------------------ */

// الكتالوج والأخبار من services/database.js
function useCatalogAndNews() {
  const [catalog, setCatalog] = useState({ grades: [], settings: {}, source: 'loading' })
  const [news, setNews] = useState([])

  useEffect(() => {
    let isCurrent = true
    Promise.all([getCatalogSnapshot(), getNews()])
      .then(([{ catalog: nextCatalog, source }, items]) => {
        if (!isCurrent) return
        setCatalog({ grades: [], settings: {}, ...nextCatalog, source })
        setNews(Array.isArray(items) ? items : [])
      })
      .catch(() => {
        if (isCurrent) setNews([])
      })
    return () => { isCurrent = false }
  }, [])

  return { catalog, news, setNews }
}

// حالة جلسة الطالب: checking | active | guest | error
function useStudentSession() {
  const [session, setSession] = useState(() => (hasStudentAccess() ? { status: 'active' } : { status: 'checking' }))
  const isMounted = useRef(true)

  const verify = useCallback(() => {
    verifyStudentSession()
      .then((student) => {
        if (isMounted.current) setSession(student ? { status: 'active', student } : { status: 'guest' })
      })
      .catch((error) => {
        if (!isMounted.current) return
        // إن كان الطالب مسجلاً أصلاً لا نُسقط الجلسة بسبب خطأ شبكة عابر
        setSession((current) => (current.status === 'active' ? current : { status: 'error', message: error.message }))
      })
  }, [])

  useEffect(() => {
    isMounted.current = true
    verify()
    return () => { isMounted.current = false }
  }, [verify])

  const retry = useCallback(() => {
    setSession({ status: 'checking' })
    verify()
  }, [verify])

  return { session, retry }
}

// تفاعل الطالب مع الأخبار (إعجاب / إلغاء إعجاب)
function useNewsReactions(setNews) {
  const [message, setMessage] = useState('')
  const [pendingId, setPendingId] = useState(null)

  const react = useCallback(async (newsId) => {
    setMessage('')
    setPendingId(newsId)
    try {
      const { isLiked, reactionCount } = await toggleNewsReaction(newsId)
      setNews((current) => current.map((item) => (item.id === newsId ? { ...item, isLiked, reactionCount } : item)))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setPendingId(null)
    }
  }, [setNews])

  return { message, pendingId, react }
}

/* ------------------------------------------------------------------ */
/* المكوّنات الفرعية                                                    */
/* ------------------------------------------------------------------ */

function GraduationCapIcon() {
  return (
    <svg className="grade-cap" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82ZM12 3 1 9l11 6 9-4.91V17h2V9L12 3Z" />
    </svg>
  )
}

function CatalogStatus({ source }) {
  const { t } = useLocale()
  return (
    <span className={`catalog-status ${source}`} role="status">
      <i aria-hidden="true" />
      {t(CATALOG_STATUS_LABELS[source] ?? CATALOG_STATUS_LOADING)}
    </span>
  )
}

function AccountActions({ session, onRetry }) {
  const { t } = useLocale()

  if (session.status === 'checking') {
    return <span className="grade-session-status" role="status">{t('جارٍ التحقق من حسابك...')}</span>
  }

  if (session.status === 'error') {
    return (
      <div className="grade-session-status" role="status">
        <span>{t(session.message)}</span>
        <button className="grade-login-link" type="button" onClick={onRetry}>{t('إعادة المحاولة')}</button>
      </div>
    )
  }

  return (
    <nav className="grade-account-actions" aria-label={t('حساب الطالب')}>
      {session.status === 'active'
        ? <Link className="grade-register-button" to="/dashboard/feed">{t('مساحة الطالب')}</Link>
        : (
          <>
            <Link className="grade-register-button" to="/register">{t('طلب تسجيل')}</Link>
            <Link className="grade-login-link" to="/login">{t('تسجيل الدخول')}</Link>
          </>
        )}
    </nav>
  )
}

function HeroSection({ settings, source, session, onRetry }) {
  const { t } = useLocale()
  return (
    <section className="grade-home-intro">
      <img
        className="grade-center-logo"
        src={settings.logoPath || DEFAULTS.logoPath}
        alt={t(settings.centerName ?? DEFAULTS.centerName)}
      />
      <h1>{t(settings.homeTitle ?? DEFAULTS.homeTitle)}</h1>
      <div className="gold-divider" aria-hidden="true"><i />✦<i /></div>
      <p>{t(settings.homeSubtitle ?? DEFAULTS.homeSubtitle)}</p>
      <CatalogStatus source={source} />
      <AccountActions session={session} onRetry={onRetry} />
    </section>
  )
}

function GradeTile({ grade, index }) {
  const { t } = useLocale()
  return (
    <Link className="grade-tile" to={`/grades/${grade.id}`} style={{ '--tile-order': index }}>
      <span className="grade-medallion">
        <span>{grade.id > GRADUATE_CAP_AFTER_GRADE_ID ? <GraduationCapIcon /> : grade.id}</span>
      </span>
      <strong>{t(grade.name)}</strong>
      <small>{grade.stage}</small>
    </Link>
  )
}

function GradePicker({ grades }) {
  const { t } = useLocale()
  return (
    <section className="grade-picker" aria-label={t('الصفوف الدراسية')}>
      {grades.map((grade, index) => <GradeTile key={grade.id} grade={grade} index={index} />)}
    </section>
  )
}

function CatalogSummary({ gradeCount, subjectCount, teacherCount }) {
  const { t } = useLocale()
  const formatNumber = useNumberFormatter()
  const stats = [
    { label: 'صفوف دراسية', value: gradeCount },
    { label: 'مادة وخدمة', value: subjectCount },
    { label: 'مدرساً ومدرسة', value: teacherCount },
  ]

  return (
    <section className="catalog-summary" aria-label={t('ملخص المركز')}>
      {stats.map(({ label, value }) => (
        <div key={label}>
          <strong>{formatNumber(value)}</strong>
          <span>{t(label)}</span>
        </div>
      ))}
    </section>
  )
}

function NewsItem({ item, canReact, showLoginHint, isPending, onReact }) {
  const { t } = useLocale()
  const formatNumber = useNumberFormatter()
  const href = toSafeHref(item.link)

  return (
    <article className="news-item">
      <h3>{t(item.title)}</h3>
      <p>{t(item.summary ?? item.description)}</p>
      {href && <a href={href} target="_blank" rel="noopener noreferrer">{t('المزيد')}</a>}
      <div className="news-reaction-row">
        <button
          className="news-reaction-button"
          type="button"
          aria-pressed={Boolean(item.isLiked)}
          onClick={() => onReact(item.id)}
          disabled={!canReact || isPending}
          title={t(canReact ? 'تفاعل مع الخبر' : 'سجّل الدخول للتفاعل')}
        >
          <span aria-hidden="true">{item.isLiked ? '♥' : '♡'}</span> <span>{formatNumber(item.reactionCount ?? 0)}</span>
        </button>
        {showLoginHint && <Link className="text-link" to="/login">{t('دخول للتفاعل')}</Link>}
      </div>
    </article>
  )
}

// ملاحظة: id="grades" هنا هو هدف الرابط /#grades (انظر تأثير التمرير في Home)
function NewsSection({ news, canReact, showLoginHint, pendingId, reactionMessage, onReact }) {
  const { t } = useLocale()
  return (
    <section id="grades" className="catalog-news" aria-label={t('آخر الأخبار والإعلانات')}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{t('آخر الأخبار والإعلانات')}</span>
          <h2>{t('من المعهد مباشرة')}</h2>
        </div>
      </div>
      {news.length
        ? (
          <div className="news-list">
            {news.map((item) => (
              <NewsItem
                key={item.id}
                item={item}
                canReact={canReact}
                showLoginHint={showLoginHint}
                isPending={pendingId === item.id}
                onReact={onReact}
              />
            ))}
          </div>
        )
        : <p className="catalog-empty-news">{t('لا توجد أخبار جديدة حالياً.')}</p>}
      {reactionMessage && <p className="form-message" role="status">{t(reactionMessage)}</p>}
    </section>
  )
}

function StudentSpaceBand({ isSignedIn, studentName }) {
  const { t } = useLocale()
  const heading = isSignedIn
    ? `${t('أهلاً بعودتك')} ${studentName ?? ''}`.trim()
    : t('حسابك ودراستك في مكان واحد')

  return (
    <section id="student-space" className="student-space-band">
      <div>
        <span className="eyebrow">{t('مساحة الطالب')}</span>
        <h2>{heading}</h2>
        <p>
          {t(isSignedIn
            ? 'تابع موجزك وإعلاناتك وعلاماتك من مساحة الطالب.'
            : 'تابع طلباتك، بيانات اشتراكك، والمواد التي اخترتها.')}
        </p>
      </div>
      <Link className="button button-dark" to={isSignedIn ? '/dashboard/feed' : '/login'}>
        {t(isSignedIn ? 'دخول مساحة الطالب' : 'تسجيل الدخول')} <span aria-hidden="true">←</span>
      </Link>
    </section>
  )
}

function ContactSection({ settings }) {
  const { t } = useLocale()
  const { contactText, contactPhone, contactTelegram } = settings
  const telegramHref = toSafeHref(contactTelegram)

  if (!contactText && !contactPhone && !telegramHref) return null

  return (
    <section className="catalog-contact-section">
      {contactText && <p>{contactText}</p>}
      <nav className="catalog-contacts" aria-label={t('التواصل مع المركز')}>
        {contactPhone && <a href={`tel:${contactPhone}`}>{t('اتصال')}: <bdi dir="ltr">{contactPhone}</bdi></a>}
        {telegramHref && <a href={telegramHref} target="_blank" rel="noopener noreferrer">{t('تيليغرام المركز')}</a>}
      </nav>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* الصفحة                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  const { hash } = useLocation()
  const { catalog, news, setNews } = useCatalogAndNews()
  const { session, retry } = useStudentSession()
  const reactions = useNewsReactions(setNews)

  const settings = catalog.settings ?? {}
  const isStudentSignedIn = session.status === 'active'

  usePageTitle(settings.homeTitle ?? DEFAULTS.homeTitle)

  useEffect(() => {
    if (hash !== GRADES_HASH) return
    document.getElementById('grades')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [hash])

  const { teacherCount, subjectCount } = useMemo(() => {
    const teachers = new Set()
    let subjects = 0
    for (const grade of catalog.grades) {
      for (const subject of grade.subjects ?? []) {
        subjects += 1
        for (const teacher of subject.teachers ?? []) teachers.add(teacher)
      }
    }
    return { teacherCount: teachers.size, subjectCount: subjects }
  }, [catalog.grades])

  return (
    <section className="grade-home">
      <HeroSection settings={settings} source={catalog.source} session={session} onRetry={retry} />
      <GradePicker grades={catalog.grades} />
      <CatalogSummary gradeCount={catalog.grades.length} subjectCount={subjectCount} teacherCount={teacherCount} />
      <NewsSection
        news={news}
        canReact={isStudentSignedIn}
        showLoginHint={!isStudentSignedIn && session.status !== 'checking'}
        pendingId={reactions.pendingId}
        reactionMessage={reactions.message}
        onReact={reactions.react}
      />
      <StudentSpaceBand isSignedIn={isStudentSignedIn} studentName={session.student?.studentName} />
      <ContactSection settings={settings} />
    </section>
  )
}

