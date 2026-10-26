export function LoadingState({ label = 'جارٍ التحميل...' }) {
  return (
    <div className="page-state" role="status">
      <p>{label}</p>
    </div>
  )
}

export function ErrorState({ message = 'حدث خطأ ما', onRetry }) {
  return (
    <div className="page-state" role="alert">
      <p>{message}</p>
      {onRetry && <button type="button" onClick={onRetry}>إعادة المحاولة</button>}
    </div>
  )
}
