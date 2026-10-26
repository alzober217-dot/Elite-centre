import { useEffect, useState } from 'react'
import TeacherCard from '../components/TeacherCard.jsx'
import usePageTitle from '../hooks/usePageTitle.js'
import { getTeachers } from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'

export default function Teachers() {
  const { language, t } = useLocale()
  const [teachers, setTeachers] = useState([])
  const [search, setSearch] = useState('')
  usePageTitle('المعلمون')
  useEffect(() => { getTeachers().then(setTeachers) }, [])
  const filteredTeachers = teachers.filter((teacher) => `${teacher.name} ${teacher.subject}`.toLocaleLowerCase(language).includes(search.trim().toLocaleLowerCase(language)))
  return <section className="listing-page"><span className="eyebrow">{t('فريق التعليم')}</span><h1 className="page-title">{t('خبرة قريبة منك.')}</h1><p className="page-intro">{t('معلمون يشرحون ببساطة، ويصغون جيداً، ويؤمنون أن لكل طالب طريقته الخاصة.')}</p><label className="course-search teacher-search"><span className="visually-hidden">{t('ابحث عن معلم أو تخصص')}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('ابحث عن معلم أو تخصص')} /><span aria-hidden="true">⌕</span></label><p className="course-result-count" aria-live="polite">{new Intl.NumberFormat(language).format(filteredTeachers.length)} {t('مدرسون')}</p>{filteredTeachers.length ? <div className="teacher-grid">{filteredTeachers.map((teacher) => <TeacherCard key={teacher.id} teacher={teacher} />)}</div> : <div className="empty-state"><h2>{t('لا توجد نتائج مطابقة')}</h2><p>{t('جرّب اسماً أو تخصصاً آخر.')}</p></div>}</section>
}