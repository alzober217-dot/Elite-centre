import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  isCourseFavorite,
  toggleCourseFavorite,
} from '../services/database.js'
import { useLocale } from '../contexts/LocaleContext.jsx'

export default function CourseCard({ course }) {
  const { language, t } = useLocale()
  const [favorite, setFavorite] = useState(false)
  const [favoriteLoaded, setFavoriteLoaded] = useState(false)
  const [isUpdatingFavorite, setIsUpdatingFavorite] = useState(false)

  const courseId = course?.id

  useEffect(() => {
    let isCurrent = true

    if (courseId == null) {
      setFavorite(false)
      setFavoriteLoaded(true)

      return () => {
        isCurrent = false
      }
    }

    setFavoriteLoaded(false)

    isCourseFavorite(courseId)
      .then((result) => {
        if (isCurrent) setFavorite(Boolean(result))
      })
      .catch((error) => {
        console.error(
          'Failed to load course favorite state:',
          error,
        )

        if (isCurrent) setFavorite(false)
      })
      .finally(() => {
        if (isCurrent) setFavoriteLoaded(true)
      })

    return () => {
      isCurrent = false
    }
  }, [courseId])

  async function handleToggleFavorite() {
    if (courseId == null || isUpdatingFavorite) return

    setIsUpdatingFavorite(true)

    try {
      const nextFavorite = Boolean(
        await toggleCourseFavorite(courseId),
      )

      setFavorite(nextFavorite)

      window.dispatchEvent(
        new CustomEvent('elite-center:favorites-changed', {
          detail: {
            courseId,
            isFavorite: nextFavorite,
          },
        }),
      )
    } catch (error) {
      console.error(
        'Failed to update course favorite:',
        error,
      )
    } finally {
      setIsUpdatingFavorite(false)
    }
  }

  if (!course) return null

  const title = course.title ?? 'مادة دراسية'

  const category =
    course.gradeTitle ??
    course.category ??
    course.level ??
    ''

  const price =
    course.price == null
      ? null
      : `${new Intl.NumberFormat(language).format(course.price)}${
          course.currency ? ` ${course.currency}` : ''
        }`

  return (
    <article
      className={`course-card tone-${course.color ?? 'default'}`}
    >
      <div className="course-card-top">
        <span className="eyebrow">
          {t(category)}
        </span>

        <button
          className="favorite-toggle"
          type="button"
          aria-label={t(
            favorite
              ? 'إزالة المادة من المفضلة'
              : 'إضافة المادة إلى المفضلة',
          )}
          aria-pressed={favorite}
          disabled={
            !favoriteLoaded ||
            isUpdatingFavorite ||
            courseId == null
          }
          onClick={handleToggleFavorite}
        >
          <span aria-hidden="true">
            {favorite ? '★' : '☆'}
          </span>
        </button>
      </div>

      <h3>{t(title)}</h3>

      {course.teacher ? (
        <p>{t(course.teacher)}</p>
      ) : null}

      <div className="course-card-bottom">
        <strong>
          {price ?? t(course.level ?? '')}
        </strong>

        {courseId != null ? (
          <Link
            to={`/courses/${encodeURIComponent(
              String(courseId),
            )}`}
            aria-label={`${t('التفاصيل')} ${t(title)}`}
          >
            {t('التفاصيل')}{' '}
            <span aria-hidden="true">←</span>
          </Link>
        ) : null}
      </div>
    </article>
  )
}
