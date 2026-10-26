import { useEffect, useState } from 'react'
import TeacherCard from '../../components/TeacherCard.jsx'
import usePageTitle from '../../hooks/usePageTitle.js'
import { getTeachers } from '../../services/database.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'

export default function DashboardTeachers() {
  const { t } = useLocale()
  const [teachers, setTeachers] = useState([])
  usePageTitle('المعلمون')
  useEffect(() => { getTeachers().then(setTeachers) }, [])
  return <section className="dashboard-page"><span className="eyebrow">{t('مساحة الطالب')}</span><h1 className="page-title">{t('معلموك')}</h1><p className="page-intro">{t('تعرّف على فريق التعليم وتخصصاتهم.')}</p><div className="teacher-grid">{teachers.map((teacher) => <TeacherCard key={teacher.id} teacher={teacher} />)}</div></section>
}