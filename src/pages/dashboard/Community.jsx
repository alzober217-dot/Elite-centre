import { useCallback, useEffect, useState } from 'react'
import usePageTitle from '../../hooks/usePageTitle.js'
import {
  addCommunityComment,
  createCommunityPost,
  getCommunityPosts,
  getSavedCommunityPosts,
  reportCommunityPost,
  toggleCommunityBookmark,
  toggleCommunityReaction,
} from '../../services/database.js'
import { useLocale } from '../../contexts/LocaleContext.jsx'

function PostCard({ post, onUpdate, onError }) {
  const { language, t } = useLocale()
  const [comment, setComment] = useState('')
  const [reportReason, setReportReason] = useState('')
  const [showReport, setShowReport] = useState(false)
  const [busy, setBusy] = useState(false)

  async function run(action) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      onError(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="community-post">
      <header className="community-post-author">
        <span className="community-avatar" aria-hidden="true">{post.author.studentName?.slice(0, 1) || 'ط'}</span>
        <div><strong>{post.author.studentName}</strong><small>{t(post.author.grade)} · {new Date(post.createdAt).toLocaleString(language)}</small></div>
      </header>
      <p className="community-post-text">{post.text}</p>
      <div className="community-post-actions">
        <button type="button" aria-pressed={post.isLiked} disabled={busy} onClick={() => run(async () => {
          const result = await toggleCommunityReaction(post.id)
          onUpdate({ ...post, ...result })
        })}>{t(post.isLiked ? '♥ أعجبني' : '♡ إعجاب')} · {new Intl.NumberFormat(language).format(post.reactionCount)}</button>
        <button type="button" aria-pressed={post.isSaved} disabled={busy} onClick={() => run(async () => {
          const result = await toggleCommunityBookmark(post.id)
          onUpdate({ ...post, isSaved: result.isSaved })
        })}>{t(post.isSaved ? 'إزالة من المحفوظات' : 'حفظ')}</button>
        <button type="button" disabled={busy} onClick={() => setShowReport((value) => !value)}>{t('إبلاغ')}</button>
      </div>
      {showReport && <form className="community-inline-form" onSubmit={(event) => {
        event.preventDefault()
        run(async () => {
          await reportCommunityPost(post.id, reportReason)
          setReportReason('')
          setShowReport(false)
          onError(t('تم إرسال البلاغ إلى إدارة المركز.'))
        })
      }}>
        <label>{t('سبب الإبلاغ')}<input value={reportReason} onChange={(event) => setReportReason(event.target.value)} maxLength={300} required /></label>
        <button className="button button-light" type="submit" disabled={busy}>{t('إرسال البلاغ')}</button>
      </form>}
      <section className="community-comments" aria-label={t('التعليقات')}>
        {post.comments.map((item) => <p key={item.id}><strong>{item.author.studentName}:</strong> {item.text}</p>)}
        <form className="community-comment-form" onSubmit={(event) => {
          event.preventDefault()
          run(async () => {
            const result = await addCommunityComment(post.id, comment)
            onUpdate({ ...post, comments: [...post.comments, result.item], commentCount: post.commentCount + 1 })
            setComment('')
          })
        }}>
          <label className="visually-hidden" htmlFor={`comment-${post.id}`}>{t('أضف تعليقاً')}</label>
          <input id={`comment-${post.id}`} value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} placeholder={t('أضف تعليقاً...')} required />
          <button type="submit" disabled={busy}>{t('إرسال')}</button>
        </form>
      </section>
    </article>
  )
}

export default function Community({ savedOnly = false }) {
  const { language, t } = useLocale()
  const [posts, setPosts] = useState([])
  const [cursor, setCursor] = useState(null)
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [loadedKey, setLoadedKey] = useState('')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isPosting, setIsPosting] = useState(false)
  const [loadFailure, setLoadFailure] = useState({ key: '', message: '' })
  const [actionError, setActionError] = useState('')
  const [status, setStatus] = useState('')
  const requestKey = `${savedOnly ? 'saved' : 'feed'}\u0000${search}`
  const isLoading = loadedKey !== requestKey || isLoadingMore
  const error = actionError || (loadFailure.key === requestKey ? loadFailure.message : '')
  usePageTitle(savedOnly ? 'المنشورات المحفوظة' : 'موجز الطلاب')

  const fetchPosts = useCallback(async (nextCursor = null, append = false) => {
    const result = savedOnly ? await getSavedCommunityPosts() : await getCommunityPosts(append ? nextCursor : null, search)
    const items = savedOnly && search ? result.items.filter((post) => `${post.text} ${post.author.studentName} ${post.author.grade}`.toLocaleLowerCase(language).includes(search.trim().toLocaleLowerCase(language))) : result.items
    return { items, nextCursor: result.nextCursor ?? null }
  }, [language, savedOnly, search])

  useEffect(() => {
    let isCurrent = true
    fetchPosts().then(({ items, nextCursor }) => {
      if (!isCurrent) return
      setPosts(items)
      setCursor(nextCursor)
      setLoadedKey(requestKey)
      setLoadFailure({ key: requestKey, message: '' })
    }).catch((loadError) => {
      if (!isCurrent) return
      setLoadedKey(requestKey)
      setLoadFailure({ key: requestKey, message: loadError.message })
    })
    return () => { isCurrent = false }
  }, [fetchPosts, requestKey])

  async function submitPost(event) {
    event.preventDefault()
    setIsPosting(true)
    setActionError('')
    setStatus('')
    try {
      const result = await createCommunityPost(text)
      if (!savedOnly) setPosts((current) => [result.item, ...current])
      setText('')
      setStatus('نُشر منشورك.')
    } catch (postError) {
      setActionError(postError.message)
    } finally {
      setIsPosting(false)
    }
  }

  function updatePost(nextPost) {
    setPosts((current) => current.map((post) => post.id === nextPost.id ? nextPost : post))
  }

  function loadMore() {
    if (cursor === null) return
    setIsLoadingMore(true)
    fetchPosts(cursor, true).then(({ items, nextCursor }) => {
      setPosts((current) => [...current, ...items])
      setCursor(nextCursor)
      setLoadFailure({ key: requestKey, message: '' })
    }).catch((loadError) => {
      setActionError(loadError.message)
    }).finally(() => setIsLoadingMore(false))
  }

  return (
    <section className="dashboard-page community-page">
      <span className="eyebrow">{t(savedOnly ? 'مساحة الطالب' : 'مجتمع الطلاب')}</span>
      <h1 className="page-title">{t(savedOnly ? 'المنشورات المحفوظة' : 'موجز الطلاب')}</h1>
      <p className="page-intro">{t('الموجز خاص بالطلاب أصحاب الاشتراكات النشطة. شارك سؤالاً أو فائدة دراسية باحترام.')}</p>
      <label className="community-search">{t('ابحث في المنشورات')}<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder={t('كلمة أو اسم طالب')} /></label>
      {!savedOnly && <form className="community-composer" onSubmit={submitPost}>
        <label htmlFor="community-post">{t('اكتب منشوراً')}</label>
        <textarea id="community-post" value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} rows={4} required />
        <div><small>{new Intl.NumberFormat(language).format(text.length)}/2000</small><button className="button button-dark" type="submit" disabled={isPosting || !text.trim()}>{t(isPosting ? 'جارٍ النشر...' : 'نشر')}</button></div>
      </form>}
      {error && <p className="form-message" role="alert">{error}</p>}
      {status && <p className="form-message" role="status">{t(status)}</p>}
      {isLoading && !posts.length ? <p role="status">{t('جارٍ تحميل الموجز...')}</p> : posts.length ? (
        <div className="community-post-list">
          {posts.map((post) => <PostCard key={post.id} post={post} onUpdate={updatePost} onError={setStatus} />)}
          {!savedOnly && cursor !== null && <button className="button button-light" type="button" disabled={isLoading} onClick={loadMore}>{t('تحميل منشورات أقدم')}</button>}
        </div>
      ) : !isLoading && <div className="empty-state"><h2>{t(savedOnly ? 'لا توجد منشورات محفوظة' : 'لا توجد منشورات بعد')}</h2><p>{t(savedOnly ? 'احفظ منشوراً للعودة إليه لاحقاً.' : 'كن أول من يشارك فائدة مع زملائه.')}</p></div>}
    </section>
  )
}
