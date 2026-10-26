import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle.js'
import { getTeacherById } from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'

export default function TeacherDetails() {
  const { t } = useLocale()
  const { teacherId } = useParams()
  const [teacher, setTeacher] = useState(null)
  useEffect(() => { getTeacherById(teacherId).then(setTeacher) }, [teacherId])
  usePageTitle(teacher?.name ?? 'ملف المعلم')
  if (!teacher) return <section className="listing-page"><h1 className="page-title">{t('لم نعثر على هذا الملف.')}</h1><Link className="text-link" to="/teachers">{t('العودة إلى المعلمين')} ←</Link></section>
  return <section className="detail-page"><Link className="back-link" to="/teachers">← {t('جميع المعلمين')}</Link><div className={`teacher-avatar detail-avatar tone-${teacher.color}`}>{teacher.initials}</div><span className="eyebrow">{t(teacher.subject)}</span><h1 className="page-title">{t('الأستاذ')} {teacher.name}</h1><p className="page-intro">{t(teacher.experience)}، {t('يقدّم دروساً تفاعلية تركز على الفهم والتطبيق.')}</p><Link className="button button-dark" to="/login">{t('استفسر عن المواد')} <span aria-hidden="true">←</span></Link></section>
}