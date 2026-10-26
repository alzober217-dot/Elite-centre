// صفحة تفاصيل «مادة» دراسية ضمن صف (وليست دورة رقمية). المسار /courses/:courseId محفوظ للتوافق مع الراوتر الحالي.
import { Link, useParams } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle.js'
import useAsyncData from '../hooks/useAsyncData.js'
import { getCourseById } from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'
import { ErrorState, LoadingState } from '../components/PageState.jsx'

export default function CourseDetails() {
  const { language, t } = useLocale()
  const { courseId } = useParams()
  const { data: course, error, isLoading, reload } = useAsyncData(courseId, () => getCourseById(courseId))
  usePageTitle(course?.title ?? 'تفاصيل المادة')

  if (isLoading && !course) return <section className="detail-page"><LoadingState label="جارٍ تحميل تفاصيل المادة..." /></section>
  if (error) return <section className="detail-page"><ErrorState message={error} onRetry={reload} /><Link className="text-link" to="/#grades">{t('العودة إلى الصفوف')} ←</Link></section>
  if (!course) return <section className="listing-page"><h1 className="page-title">{t('لم نعثر على هذه المادة.')}</h1><Link className="text-link" to="/#grades">{t('العودة إلى الصفوف')} ←</Link></section>

  const price = new Intl.NumberFormat(language).format(course.price)
  return (
    <section className="detail-page">
      <Link className="back-link" to={`/grades/${course.gradeId}`}>← {t('العودة إلى مواد')} {t(course.gradeTitle)}</Link>
      <span className="eyebrow">{t(course.gradeTitle)} · {t(course.level)}</span>
      <h1 className="page-title">{t(course.title)}</h1>
      <p className="page-intro">{t('تعليم متخصص بإشراف')} {t(course.teacher)}.</p>
      <div className="detail-facts">
        <div><span>{t('الصف الدراسي')}</span><strong>{t(course.gradeTitle)}</strong></div>
        <div><span>{t('المدرسون')}</span><strong>{t(course.teacher)}</strong></div>
        <div><span>{t('سعر المادة')}</span><strong>{price} {course.currency}</strong></div>
      </div>
      <Link className="button button-dark" to={`/register?grade=${course.gradeId}&subject=${encodeURIComponent(course.subjectId)}`}>{t('إرسال طلب تسجيل')} <span aria-hidden="true">←</span></Link>
    </section>
  )
}

