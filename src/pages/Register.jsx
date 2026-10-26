import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle.js'
import { isValidEmail } from '../utils/formValidation.js'
import { getCatalogSnapshot, submitRegistrationRequest } from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'

// نقبل روابط ربط تيليغرام فقط (حماية من أي رابط غير متوقع قادم من الخادم).
function isSafeTelegramUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 't.me' || url.hostname === 'telegram.me')
  } catch {
    return false
  }
}

export default function Register() {
  const { language, t } = useLocale()
  const [searchParams] = useSearchParams()
  const [grades, setGrades] = useState([])
  const [gradeId, setGradeId] = useState('')
  const [selectedSubjects, setSelectedSubjects] = useState([])
  const [isRegistrationOpen, setIsRegistrationOpen] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [feedback, setFeedback] = useState({ type: '', text: '' })
  const [requestId, setRequestId] = useState('')
  const [telegramLink, setTelegramLink] = useState(null)
  const feedbackRef = useRef(null)
  const initialParams = useRef({ grade: searchParams.get('grade'), subject: searchParams.get('subject') })
  usePageTitle('طلب تسجيل')

  const formatNumber = useMemo(() => {
    const formatter = new Intl.NumberFormat(language)
    return (value) => formatter.format(value)
  }, [language])

  // التحميل مرة واحدة؛ المعاملان grade وsubject يحددان الاختيار الأولي فقط.
  useEffect(() => {
    let isCurrent = true
    getCatalogSnapshot().then(({ catalog }) => {
      if (!isCurrent) return
      setGrades(catalog.grades)
      const requestedGrade = catalog.grades.find((grade) => grade.id === Number(initialParams.current.grade))
      const activeGrade = requestedGrade ?? catalog.grades[0]
      setGradeId(String(activeGrade?.id ?? ''))
      const requestedSubject = requestedGrade?.subjects.find((subject) => String(subject.id) === initialParams.current.subject)
      if (requestedSubject) setSelectedSubjects([requestedSubject.id])
      setIsRegistrationOpen(catalog.settings?.registrationOpen !== false && catalog.settings?.registrationOpen !== 'false')
    }).catch((error) => {
      if (isCurrent) setFeedback({ type: 'error', text: error.message })
    }).finally(() => {
      if (isCurrent) setIsLoading(false)
    })
    return () => { isCurrent = false }
  }, [])

  const selectedGrade = grades.find((grade) => grade.id === Number(gradeId))

  function showFeedback(type, text) {
    setFeedback({ type, text })
    // على الهاتف قد تكون الرسالة خارج الشاشة بعد الضغط على زر الإرسال.
    requestAnimationFrame(() => feedbackRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  function toggleSubject(subjectId, checked) {
    setSelectedSubjects((current) => checked ? [...current, subjectId] : current.filter((id) => id !== subjectId))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (isSubmitting) return
    const form = event.currentTarget
    if (!isRegistrationOpen) return showFeedback('error', t('التسجيل مغلق حالياً. تواصل مع إدارة المركز.'))
    if (!selectedSubjects.length) return showFeedback('error', t('اختر مادة واحدة على الأقل.'))
    const data = new FormData(form)
    const email = String(data.get('email') ?? '').trim()
    const name = String(data.get('name') ?? '').trim()
    const phone = String(data.get('phone') ?? '').trim()
    if (name.length < 3) return showFeedback('error', t('أدخل الاسم الكامل.'))
    if (!isValidEmail(email)) return showFeedback('error', t('تحقق من البريد الإلكتروني.'))
    setIsSubmitting(true)
    setFeedback({ type: '', text: '' })
    setRequestId('')
    setTelegramLink(null)
    try {
      const result = await submitRegistrationRequest({
        name,
        phone,
        email,
        gradeId: Number(gradeId),
        programType: 'center',
        subjectIds: selectedSubjects,
      })
      setRequestId(result.id)
      setTelegramLink(result.telegramLink && isSafeTelegramUrl(result.telegramLink.url) ? result.telegramLink : null)
      showFeedback('success', t(result.telegramLink
        ? 'وصل طلبك إلى إدارة المركز. اربط حساب تيليغرام خلال 15 دقيقة لاستلام كود الدخول عند الموافقة.'
        : 'وصل طلبك إلى إدارة المركز. لم يتوفر الربط الآلي بتيليغرام؛ ستسلّمك الإدارة الكود يدوياً عند الموافقة.'))
      form.reset()
      setSelectedSubjects([])
    } catch (error) {
      showFeedback('error', error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="login-page login-branded register-page">
      <div className="login-copy">
        <img className="auth-logo" src="/elite-logo.webp" alt="Elite Center - مركز النخبة" width="120" height="120" decoding="async" fetchPriority="high" />
        <span className="brand-kicker">{t('طلب تسجيل طالب')}</span>
        <h1 className="page-title">{t('ابدأ رحلتك معنا.')}</h1>
        <p className="page-intro">{t('أرسل بياناتك واختياراتك للمراجعة من إدارة المعهد.')}</p>
        <Link className="text-link" to="/">{t('العودة إلى الصفوف')} ←</Link>
      </div>
      <form className="login-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
        <span className="eyebrow">{t('طلب تسجيل طالب')}</span>
        <label>{t('اسم الطالب')}<input name="name" autoComplete="name" required minLength={3} maxLength={100} placeholder={t('الاسم الكامل')} /></label>
        <label>{t('رقم الهاتف')}<input name="phone" type="tel" dir="ltr" inputMode="tel" autoComplete="tel" required maxLength={20} pattern="[0-9+\s\-]{7,20}" title={t('أدخل رقم هاتف صالحاً')} placeholder="09xxxxxxxx" /></label>
        <label>{t('البريد الإلكتروني')}<input name="email" type="email" dir="ltr" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck="false" required maxLength={150} placeholder="name@example.com" /></label>
        <label>{t('الصف الدراسي')}
          <select value={gradeId} onChange={(event) => { setGradeId(event.target.value); setSelectedSubjects([]) }} required disabled={isLoading || !grades.length}>
            {grades.map((grade) => <option key={grade.id} value={grade.id}>{t(grade.title)}</option>)}
          </select>
        </label>
        <fieldset className="request-subjects" disabled={isLoading || !isRegistrationOpen || !selectedGrade}>
          <legend>{t('المواد المطلوبة')}</legend>
          <div>
            {selectedGrade?.subjects.map((subject) => (
              <label key={subject.id}>
                <input type="checkbox" checked={selectedSubjects.includes(subject.id)} onChange={(event) => toggleSubject(subject.id, event.target.checked)} />
                <span>{t(subject.name)}</span>
                <small>{formatNumber(subject.price)} {subject.currency}</small>
              </label>
            ))}
          </div>
        </fieldset>
        {!isRegistrationOpen && <p className="form-message" role="status">{t('التسجيل مغلق حالياً من إدارة المركز.')}</p>}
        <div ref={feedbackRef} aria-live="polite">
          {feedback.text && <p className="form-message" role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
        </div>
        {requestId && <p className="request-reference">{t('رقم الطلب:')} <strong dir="ltr">{requestId}</strong><br />{t('احتفظ به. بعد موافقة الإدارة وتسجيل الدخول ستتمكن من متابعة الطلب.')}</p>}
        {telegramLink && <p className="request-reference"><a className="text-link" href={telegramLink.url} target="_blank" rel="noopener noreferrer">{t('اربط حساب تيليغرام الآن')}</a><br />{t('ينتهي الرابط بعد 15 دقيقة، ولا يحتوي على بياناتك الشخصية.')}</p>}
        <button className="button button-dark" type="submit" disabled={isSubmitting || isLoading || !isRegistrationOpen}>{t(isSubmitting ? 'جارٍ إرسال الطلب...' : 'إرسال طلب التسجيل')} <span aria-hidden="true">←</span></button>
        <p className="form-note">{t('هذا طلب تسجيل، وليس حساباً مفعّلاً بعد. عند الموافقة ستسلّمك الإدارة كود دخول مرتبطاً ببريدك الإلكتروني. لديك كود؟')} <Link to="/login">{t('تسجيل الدخول')}</Link></p>
      </form>
    </section>
  )
}

