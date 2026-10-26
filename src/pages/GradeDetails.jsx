import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle.js'
import useAsyncData from '../hooks/useAsyncData.js'
import { getGradeById } from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'
import { ErrorState, LoadingState } from '../components/PageState.jsx'

export default function GradeDetails() {
  const { language, t } = useLocale()
  const { gradeId } = useParams()
  const { data: grade, error, isLoading, reload } = useAsyncData(gradeId, () => getGradeById(gradeId))
  const formatNumber = useMemo(() => {
    const formatter = new Intl.NumberFormat(language)
    return (value) => formatter.format(value)
  }, [language])
  usePageTitle(grade?.title ?? 'مواد الصف')

  if (isLoading && !grade) return <section className="grade-detail-page"><LoadingState label="جارٍ تحميل المواد..." /></section>
  if (error) return <section className="grade-detail-page"><ErrorState message={error} onRetry={reload} /><Link className="back-link" to="/">{t('العودة إلى الصفوف')}</Link></section>
  if (!grade) return <section className="grade-detail-page"><h1>{t('لم نعثر على هذا الصف.')}</h1><Link className="back-link" to="/">{t('العودة إلى الصفوف')}</Link></section>

  return (
    <section className="grade-detail-page">
      <header className="grade-bar">
        <Link className="grade-bar-back" to="/" aria-label={t('العودة لاختيار الصف')}>{t('رجوع')} <span aria-hidden="true">←</span></Link>
        <div className="grade-bar-title"><h1>{t(grade.title)}</h1><p>{t(grade.stage)}</p></div>
        <Link className="grade-bar-register" to={`/register?grade=${grade.id}`}>{t('طلب تسجيل')}</Link>
      </header>
      <div className="grade-detail-heading"><span className="eyebrow">{t('اختر المادة المناسبة')}</span><p>{t('المدرسون والأسعار محدثة من إدارة المركز.')}</p></div>
      {grade.subjects.length ? <div className="subject-grid">
        {grade.subjects.map((subject, index) => (
          <article className={`subject-card accent-${index % 6}`} key={subject.id}>
            <span className="subject-number">{String(index + 1).padStart(2, '0')}</span>
            <h2>{t(subject.name)}</h2>
            <div className="subject-teachers">
              <span>{t('المدرسون')}</span>
              <strong>{subject.teachers.map((teacher) => t(teacher)).join('، ') || t('سيعلن لاحقاً')}</strong>
            </div>
            <div className="subject-card-footer">
              <span>{t('سعر المادة')}</span>
              <strong>{formatNumber(subject.price)} {subject.currency}</strong>
              <Link to={`/courses/${grade.id}-${subject.id}`} aria-label={`${t('التفاصيل')} ${t(subject.name)}`}>{t('التفاصيل')} <span aria-hidden="true">←</span></Link>
            </div>
          </article>
        ))}
      </div> : <div className="empty-state"><h2>{t('لا توجد مواد لهذا الصف حالياً')}</h2><p>{t('سيعلن المركز عن المواد عند توفرها.')}</p></div>}
    </section>
  )
}

