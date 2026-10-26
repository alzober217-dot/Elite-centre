import { useEffect, useState } from 'react'
import usePageTitle from '../../hooks/usePageTitle.js'
import { getMyRegistrationRequests } from '../../services/database.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'

const statusLabels = { pending: 'قيد المراجعة', approved: 'تمت الموافقة', rejected: 'لم تتم الموافقة' }

export default function DashboardRequests() {
  const { language, t } = useLocale()
  const [requests, setRequests] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  usePageTitle('طلباتي')

  useEffect(() => {
    let isCurrent = true
    getMyRegistrationRequests().then((result) => {
      if (isCurrent) setRequests(result)
    }).catch((requestError) => {
      if (isCurrent) setError(requestError.message)
    }).finally(() => {
      if (isCurrent) setIsLoading(false)
    })
    return () => { isCurrent = false }
  }, [])

  async function refreshRequests() {
    setError('')
    setIsLoading(true)
    try {
      setRequests(await getMyRegistrationRequests())
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <section className="dashboard-page">
      <div className="requests-heading">
        <div><span className="eyebrow">{t('مساحة الطالب')}</span><h1 className="page-title">{t('طلبات التسجيل')}</h1><p className="page-intro">{t('تابع مراجعة الإدارة لطلباتك.')}</p></div>
        <button className="button button-light" type="button" onClick={refreshRequests} disabled={isLoading}>{t('تحديث الحالة')}</button>
      </div>
      {isLoading ? <p role="status">{t('جارٍ تحميل طلباتك...')}</p> : error ? <p className="form-message" role="alert">{t(error)}</p> : requests.length ? (
        <div className="request-list">{requests.map((request) => (
          <article className="request-card" key={request.id}>
            <div className="request-card-top"><div><span className="eyebrow">{t(request.gradeTitle)} · {t('الدراسة في المركز')}</span><h2>{request.subjects?.map(t).join(', ')}</h2></div><span className={`request-status ${request.status}`}>{t(statusLabels[request.status] ?? request.status)}</span></div>
            <p>{t('رقم الطلب:')} <code>{request.id.slice(0, 8)}</code> · {new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(request.createdAt))}</p>
            {request.statusMessage && <div className="request-response"><strong>{t('رد الإدارة')}</strong><span>{t(request.statusMessage)}</span></div>}
          </article>
        ))}</div>
      ) : <div className="empty-state"><span aria-hidden="true">✳</span><h2>{t('لا توجد طلبات محفوظة على هذا الجهاز')}</h2><p>{t('أرسل طلب تسجيل من صفحة إنشاء الحساب لتتابع حالته هنا.')}</p></div>}
    </section>
  )
}