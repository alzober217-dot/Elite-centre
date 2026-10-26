import usePageTitle from '../../hooks/usePageTitle.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'

export default function DashboardCourses() {
  const { t } = useLocale()
  usePageTitle('المواد الرقمية')
  return (
    <section className="dashboard-page">
      <span className="eyebrow">{t('مساحة الطالب')}</span>
      <h1 className="page-title">{t('المواد الرقمية')}</h1>
      <p className="page-intro">{t('ستجد هنا المواد الرقمية التي يتيحها المركز للطلاب.')}</p>
      <div className="digital-courses-notice" role="status">
        <span className="digital-courses-notice-icon" aria-hidden="true">✦</span>
        <span className="eyebrow">{t('نعمل على تجهيزها')}</span>
        <h2>{t('قسم المواد الرقمية قيد الإنشاء')}</h2>
        <p>{t('نعمل على إعداد هذا القسم، وسيكون متاحاً هنا عند اكتماله.')}</p>
      </div>
    </section>
  )
}