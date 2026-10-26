import { Link } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle.js'
import { useLocale } from '../contexts/LocaleContext.jsx'

export default function Courses() {
  const { t } = useLocale()
  usePageTitle('المواد الرقمية')
  return (
    <section className="listing-page public-digital-courses">
      <span className="eyebrow">{t('مساحة التعلّم')}</span>
      <h1 className="page-title">{t('المواد الرقمية')}</h1>
      <p className="page-intro">{t('نجهّز تجربة المواد الرقمية لطلاب مركز النخبة.')}</p>
      <div className="digital-courses-notice" role="status">
        <span className="digital-courses-notice-icon" aria-hidden="true">✦</span>
        <span className="eyebrow">{t('نعمل على تجهيزها')}</span>
        <h2>{t('قسم المواد الرقمية قيد الإنشاء')}</h2>
        <p>{t('سيكون القسم متاحاً هنا فور اكتمال التجهيز.')}</p>
        <Link className="button button-dark" to="/">{t('العودة إلى الرئيسية')} <span aria-hidden="true">←</span></Link>
      </div>
    </section>
  )
}
