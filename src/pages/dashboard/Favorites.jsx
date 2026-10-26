import { useEffect, useState } from 'react'
import CourseCard from '../../components/CourseCard.jsx'
import usePageTitle from '../../hooks/usePageTitle.js'
import { getFavoriteCourses } from '../../services/database.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'

export default function DashboardFavorites() {
  const { t } = useLocale()
  const [courses, setCourses] = useState([])
  usePageTitle('المفضلة')
  useEffect(() => {
    let isCurrent = true
    const refreshFavorites = () => getFavoriteCourses().then((nextCourses) => { if (isCurrent) setCourses(nextCourses) })
    refreshFavorites()
    window.addEventListener('elite-center:favorites-changed', refreshFavorites)
    return () => {
      isCurrent = false
      window.removeEventListener('elite-center:favorites-changed', refreshFavorites)
    }
  }, [])
  return <section className="dashboard-page"><span className="eyebrow">{t('مساحة الطالب')}</span><h1 className="page-title">{t('المواد المفضلة')}</h1><p className="page-intro">{t('مواد حفظتها لتعود إليها لاحقاً.')}</p>{courses.length ? <div className="course-grid">{courses.map((course) => <CourseCard key={course.id} course={course} />)}</div> : <div className="empty-state"><span aria-hidden="true">☆</span><h2>{t('قائمتك فارغة حالياً')}</h2><p>{t('اضغط النجمة على أي مادة لحفظها هنا.')}</p></div>}</section>
}