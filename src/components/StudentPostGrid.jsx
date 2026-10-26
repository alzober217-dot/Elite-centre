import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { Link } from 'react-router-dom'

import {
  deleteCommunityPost,
  getMyCommunityPosts,
} from '../services/database.js'

import { useLocale } from '../contexts/LocaleContext.jsx'

function formatDate(value, language) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '—'
  }

  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
  }).format(date)
}

function applyPosts(result, setPosts, onStatsChange) {
  const items = Array.isArray(result?.items)
    ? result.items
    : []

  setPosts(items)

  onStatsChange?.({
    posts: Number(result?.count ?? items.length),
    likes: Number(result?.reactionCount ?? 0),
  })
}

export default function StudentPostGrid({
  onStatsChange,
  compact = false,
}) {
  const { language, t } = useLocale()

  const [posts, setPosts] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] =
    useState(null)
  const [error, setError] = useState('')

  const statsCallbackRef = useRef(onStatsChange)

  useEffect(() => {
    statsCallbackRef.current = onStatsChange
  }, [onStatsChange])

  const loadPosts = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setIsLoading(true)

      setError('')

      try {
        const result = await getMyCommunityPosts()

        applyPosts(
          result,
          setPosts,
          statsCallbackRef.current,
        )
      } catch (loadError) {
        console.error(
          'Failed to load student posts:',
          loadError,
        )

        setError(
          loadError?.message ||
            'تعذر تحميل المنشورات. حاول مجددًا.',
        )
      } finally {
        if (!quiet) setIsLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    let isCurrent = true

    async function initialLoad() {
      setIsLoading(true)
      setError('')

      try {
        const result = await getMyCommunityPosts()

        if (isCurrent) {
          applyPosts(
            result,
            setPosts,
            statsCallbackRef.current,
          )
        }
      } catch (loadError) {
        console.error(
          'Failed to load student posts:',
          loadError,
        )

        if (isCurrent) {
          setError(
            loadError?.message ||
              'تعذر تحميل المنشورات. حاول مجددًا.',
          )
        }
      } finally {
        if (isCurrent) setIsLoading(false)
      }
    }

    initialLoad()

    return () => {
      isCurrent = false
    }
  }, [])

  async function removePost(postId) {
    if (deletingId !== null) return

    setDeletingId(postId)
    setError('')

    try {
      await deleteCommunityPost(postId)

      setConfirmDeleteId(null)

      await loadPosts({ quiet: true })
    } catch (deleteError) {
      console.error(
        'Failed to delete student post:',
        deleteError,
      )

      setError(
        deleteError?.message ||
          'تعذر حذف المنشور. حاول مجددًا.',
      )
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div
      className={`student-post-grid${
        compact ? ' compact' : ''
      }`}
    >
      {isLoading ? (
        <p role="status">
          {t('جارٍ تحميل منشوراتك...')}
        </p>
      ) : null}

      {error ? (
        <p className="form-message" role="alert">
          {t(error)}{' '}

          <button
            className="text-link"
            type="button"
            onClick={() => loadPosts()}
          >
            {t('إعادة المحاولة')}
          </button>
        </p>
      ) : null}

      {!isLoading && !error && posts.length === 0 ? (
        <div className="empty-state">
          <h2>{t('لا توجد منشورات بعد')}</h2>

          <p>
            {t(
              'شارك أول منشور لك ليظهر هنا وفي موجز الطلاب.',
            )}
          </p>

          <Link
            className="button button-light"
            to="/dashboard/feed"
          >
            {t('إنشاء منشور')}
          </Link>
        </div>
      ) : null}

      {posts.map((post) => {
        const createdAt = formatDate(
          post.createdAt,
          language,
        )

        const isDeleting = deletingId === post.id

        return (
          <article
            className="student-post-tile"
            key={post.id}
          >
            <p>{post.text}</p>

            <div className="student-post-tile-meta">
              <span>{createdAt}</span>

              <span>
                ♥{' '}
                {new Intl.NumberFormat(language).format(
                  Number(post.reactionCount ?? 0),
                )}

                {' · '}

                {t('تعليق')}{' '}

                {new Intl.NumberFormat(language).format(
                  Number(post.commentCount ?? 0),
                )}
              </span>
            </div>

            <div className="student-post-tile-actions">
              <Link to="/dashboard/feed">
                {t('الموجز')}
              </Link>

              {confirmDeleteId === post.id ? (
                <>
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => removePost(post.id)}
                  >
                    {t(
                      isDeleting
                        ? 'جارٍ الحذف...'
                        : 'تأكيد الحذف',
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() =>
                      setConfirmDeleteId(null)
                    }
                  >
                    {t('إلغاء')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={deletingId !== null}
                  onClick={() =>
                    setConfirmDeleteId(post.id)
                  }
                  aria-label={`${t('حذف')} ${t(
                    'منشور بتاريخ',
                  )} ${createdAt}`}
                >
                  {t('حذف')}
                </button>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}
