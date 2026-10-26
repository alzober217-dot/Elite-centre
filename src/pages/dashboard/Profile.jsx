import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import usePageTitle from '../../hooks/usePageTitle.js'
import { getStudentProfile, hasStudentAccess, saveStudentProfile } from '../../services/database.js'
import NavigationIcon from '../../components/NavigationIcon.jsx'
import StudentPostGrid from '../../components/StudentPostGrid.jsx'
import { useLocale } from '../../contexts/LocaleContext.jsx'

const profileLinks = [
  { to: '/dashboard/feed', icon: 'news', label: 'موجز الطلاب', detail: 'شارك وتابع مجتمع الطلاب' },
  { to: '/dashboard/gallery', icon: 'gallery', label: 'معرض منشوراتي', detail: 'منشوراتك وتفاعلاتها' },
  { to: '/dashboard/announcements', icon: 'gallery', label: 'إعلانات الإدارة', detail: 'آخر تنبيهات المركز' },
  { to: '/dashboard/marks', icon: 'courses', label: 'علاماتي', detail: 'نتائجك الدراسية' },
  { to: '/dashboard/saved', icon: 'favorites', label: 'المحفوظات', detail: 'منشورات احتفظت بها' },
  { to: '/dashboard/requests', icon: 'requests', label: 'طلباتي', detail: 'تابع طلبات التسجيل' },
  { to: '/dashboard/courses', icon: 'grades', label: 'المواد الرقمية', detail: 'قريباً في مساحة الطالب' },
]

export default function Profile() {
  const { language, t } = useLocale()
  const [profile, setProfile] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [socialStats, setSocialStats] = useState(null)
  const handleStatsChange = useCallback((stats) => setSocialStats(stats), [])
  usePageTitle('الملف الشخصي')
  useEffect(() => {
    getStudentProfile().then(setProfile).catch((error) => setMessage(error.message)).finally(() => setIsLoading(false))
  }, [])

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 1_500_000) {
      setMessage('اختر صورة PNG أو JPEG أو WebP بحجم لا يتجاوز 1.5 ميغابايت.')
      event.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => setProfile((current) => ({ ...current, photoDataUrl: String(reader.result) }))
    reader.readAsDataURL(file)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setIsSaving(true)
    setMessage('')
    try {
      setProfile(await saveStudentProfile(profile))
      setMessage('تم حفظ بيانات الملف الشخصي.')
    } catch (error) {
      setMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) return <section className="dashboard-page"><p role="status">جارٍ تحميل ملفك الشخصي...</p></section>
  if (!profile) return <section className="dashboard-page"><p className="form-message" role="alert">{message || 'تعذر تحميل الملف الشخصي.'}</p>{hasStudentAccess() ? <button className="button button-dark" type="button" onClick={() => { setIsLoading(true); setMessage(''); getStudentProfile().then(setProfile).catch((error) => setMessage(error.message)).finally(() => setIsLoading(false)) }}>إعادة المحاولة</button> : <Link className="button button-dark" to="/login">تسجيل الدخول</Link>}</section>

  return (
    <section className="dashboard-page profile-page">
      <div className="profile-page-heading">
        <div><span className="eyebrow">{t('مساحة الطالب')}</span><h1 className="page-title">{t('ملفي الشخصي')}</h1></div>
          <Link className="profile-home-link" to="/"><NavigationIcon name="home" /><span>{t('العودة إلى الرئيسية')}</span></Link>
      </div>
      <section className="student-profile-card" aria-label="الملف الشخصي">
        <div className="student-profile-overview">
          <div className="student-profile-avatar-ring">
            {profile.photoDataUrl ? <img src={profile.photoDataUrl} alt={`الصورة الشخصية لـ ${profile.name || 'الطالب'}`} /> : <span aria-hidden="true">{profile.name?.trim().slice(0, 1) || 'ط'}</span>}
          </div>
          <div className="student-profile-summary">
            <div className="student-profile-title-row">
              <div><h2>{profile.name || t('الطالب')}</h2><p dir="ltr">{profile.email}</p></div>
              <span className="profile-active-badge"><i /> {t('اشتراك نشط')}</span>
            </div>
            <div className="student-profile-stats" aria-label={t('ملخص الدراسة')}>
              <div><strong>{socialStats?.posts == null ? '—' : new Intl.NumberFormat(language).format(socialStats.posts)}</strong><span>{t('منشورات')}</span></div>
              <div><strong>{socialStats?.likes == null ? '—' : new Intl.NumberFormat(language).format(socialStats.likes)}</strong><span>{t('إعجابات')}</span></div>
              <div><strong>{t(profile.grade || '—')}</strong><span>{t('الصف الدراسي')}</span></div>
            </div>
            <p className="student-profile-bio">{t('مساحة دراستك في مركز النخبة — تابع نتائجك وإعلاناتك وموادك من مكان واحد.')}</p>
          </div>
        </div>
        <form className="student-profile-form" onSubmit={handleSubmit}>
          <div className="student-profile-actions">
            <label className="button button-light profile-photo-button">{t('تغيير الصورة')}<input className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={handlePhotoChange} /></label>
            {profile.photoDataUrl && <button className="profile-remove-photo" type="button" onClick={() => { setProfile((current) => ({ ...current, photoDataUrl: '' })); setMessage('') }}>{t('إزالة الصورة')}</button>}
            <button className="button button-dark profile-save-button" type="submit" disabled={isSaving}>{t(isSaving ? 'جارٍ الحفظ...' : 'حفظ التغييرات')}</button>
          </div>
          <div className="student-profile-details">
            <label><span>{t('الاسم الكامل')}</span><input value={profile.name ?? ''} readOnly autoComplete="name" /></label>
            <label><span>{t('البريد الإلكتروني')}</span><input value={profile.email ?? ''} readOnly dir="ltr" /></label>
            <label><span>{t('رقم الهاتف')}</span><input value={profile.phone ?? ''} readOnly autoComplete="tel" type="tel" /></label>
          </div>
          {message && <p className="form-message" role="status">{t(message)}</p>}
        </form>
      </section>
      <section className="profile-shortcuts" aria-labelledby="profile-posts-title">
        <div className="profile-section-heading"><div><span className="eyebrow">{t('نشاطك الاجتماعي')}</span><h2 id="profile-posts-title">{t('منشوراتي')}</h2></div><Link className="text-link" to="/dashboard/gallery">{t('عرض المعرض')}</Link></div>
        <StudentPostGrid compact onStatsChange={handleStatsChange} />
      </section>
      <section className="profile-shortcuts" aria-labelledby="profile-shortcuts-title">
        <div className="profile-section-heading"><div><span className="eyebrow">{t('مساحتك الدراسية')}</span><h2 id="profile-shortcuts-title">{t('اختصارات الطالب')}</h2></div></div>
        <div className="profile-shortcut-grid">
          {profileLinks.map((item) => <Link className="profile-shortcut" key={item.to} to={item.to}>
            <span className="profile-shortcut-icon"><NavigationIcon name={item.icon} /></span>
            <span className="profile-shortcut-copy"><strong>{t(item.label)}</strong><small>{t(item.detail)}</small></span>
            <span className="profile-shortcut-arrow" aria-hidden="true">←</span>
          </Link>)}
        </div>
      </section>
    </section>
  )
}