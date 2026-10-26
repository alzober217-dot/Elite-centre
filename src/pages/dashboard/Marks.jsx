import { useEffect, useState } from 'react'
import usePageTitle from '../../hooks/usePageTitle.js'
import { getMyMarks } from '../../services/database.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'

export default function Marks() {
  const { language, t } = useLocale()
  const [marks, setMarks] = useState([])
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  usePageTitle('علاماتي')
  useEffect(() => {
    getMyMarks().then((result) => setMarks(result.items)).catch((loadError) => setError(loadError.message)).finally(() => setIsLoading(false))
  }, [])
  return (
    <section className="dashboard-page">
      <span className="eyebrow">{t('الملف الدراسي')}</span>
      <h1 className="page-title">{t('علاماتي')}</h1>
      <p className="page-intro">{t('لا يمكنك الاطلاع إلا على العلامات المسجلة لمعرف اشتراكك.')}</p>
      {error && <p className="form-message" role="alert">{t(error)}</p>}
      {isLoading ? <p role="status">{t('جارٍ تحميل العلامات...')}</p> : marks.length ? <div className="marks-table-wrap">
        <table className="marks-table">
          <thead><tr><th>{t('المادة')}</th><th>{t('الاختبار')}</th><th>{t('الفصل')}</th><th>{t('العلامة')}</th><th>{t('التاريخ')}</th></tr></thead>
          <tbody>{marks.map((mark) => <tr key={mark.id}><td>{t(mark.subject)}</td><td>{t(mark.exam)}</td><td>{t(mark.term)}</td><td>{new Intl.NumberFormat(language).format(mark.score)} / {new Intl.NumberFormat(language).format(mark.maxScore)}</td><td>{mark.date}</td></tr>)}</tbody>
        </table>
      </div> : <div className="empty-state"><h2>{t('لا توجد علامات منشورة')}</h2><p>{t('ستظهر النتائج هنا بعد اعتمادها من الإدارة.')}</p></div>}
    </section>
  )
}
