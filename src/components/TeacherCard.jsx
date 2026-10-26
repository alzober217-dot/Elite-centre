import { Link } from 'react-router-dom'
import { useLocale } from '../contexts/LocaleContext.jsx'

export default function TeacherCard({ teacher }) {
  const { t } = useLocale()
  return <article className="teacher-card"><div className={`teacher-avatar tone-${teacher.color}`} aria-hidden="true">{teacher.initials}</div><div className="teacher-info"><h3>{teacher.name}</h3><p>{t(teacher.subject)} · {t(teacher.experience)}</p></div><Link className="text-link" to={`/teachers/${teacher.id}`} aria-label={`${t('الاطلاع على ملف')} ${teacher.name}`}>←</Link></article>
}