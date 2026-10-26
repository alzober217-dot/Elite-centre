import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle.js'
import { hasStudentAccess, verifyAccessCode, verifyStudentSession } from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'
import { LoadingState } from '../components/PageState.jsx'

export default function Login() {
  const { t } = useLocale()
  const [message, setMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCheckingSession, setIsCheckingSession] = useState(!hasStudentAccess())
  const navigate = useNavigate()
  usePageTitle('بوابة الطالب')

  useEffect(() => {
    if (hasStudentAccess()) return
    let isCurrent = true
    verifyStudentSession().then((session) => {
      if (isCurrent && session) navigate('/dashboard/profile', { replace: true })
    }).catch((error) => {
      if (isCurrent) setMessage(error.message)
    }).finally(() => {
      if (isCurrent) setIsCheckingSession(false)
    })
    return () => { isCurrent = false }
  }, [navigate])

  if (hasStudentAccess()) return <Navigate to="/dashboard/profile" replace />

  async function handleSubmit(event) {
    event.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    setMessage('')
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') ?? '').trim()
    const code = String(data.get('code') ?? '').trim()
    if (!email || !code) {
      setMessage(t('أدخل البريد الإلكتروني وكود الدخول الذي سلّمته لك إدارة المعهد.'))
      setIsSubmitting(false)
      return
    }
    try {
      await verifyAccessCode(email, code)
      navigate('/dashboard/profile', { replace: true })
    } catch (error) {
      // رسالة الخادم عامة عمداً ولا تكشف إن كان الحساب موجوداً.
      setMessage(error.message || t('تعذر تسجيل الدخول. تحقق من البيانات وحاول مجدداً.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isCheckingSession) return <main className="dashboard-access-state"><LoadingState label="جارٍ التحقق من جلسة الطالب..." /></main>

  return (
    <section className="login-page login-branded">
      <div className="login-copy">
        <img className="auth-logo" src="/elite-logo.webp" alt="Elite Center - مركز النخبة" width="120" height="120" decoding="async" fetchPriority="high" />
        <span className="brand-kicker">{t('مساحة الطالب')}</span>
        <h1 className="page-title">{t('أهلاً بعودتك.')}</h1>
        <p className="page-intro">{t('استخدم البريد الإلكتروني وكود الدخول اللذين سلّمتهما لك إدارة المعهد.')}</p>
        <Link className="text-link" to="/">{t('العودة إلى الصفوف')} ←</Link>
      </div>
      <form className="login-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
        <span className="eyebrow">{t('تسجيل الدخول')}</span>
        <label>{t('البريد الإلكتروني')}
          <input name="email" type="email" dir="ltr" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck="false" required placeholder="name@example.com" aria-describedby={message ? 'login-message' : undefined} />
        </label>
        <label>{t('كود الدخول')}
          <input name="code" dir="ltr" autoComplete="one-time-code" autoCapitalize="characters" autoCorrect="off" spellCheck="false" required maxLength={64} placeholder="ELITE-XXXXXXXXXX" aria-describedby={message ? 'login-message' : undefined} />
        </label>
        {message && <p id="login-message" className="form-message" role="alert">{t(message)}</p>}
        <button className="button button-dark" type="submit" disabled={isSubmitting}>{t(isSubmitting ? 'جارٍ التحقق...' : 'دخول الطالب')} <span aria-hidden="true">←</span></button>
        <p className="form-note">{t('الكود مرتبط بالبريد المسجّل ويبقى فعّالاً حتى تغيّره الإدارة. طالب جديد؟')} <Link to="/register">{t('إرسال طلب تسجيل')}</Link></p>
      </form>
    </section>
  )
}

