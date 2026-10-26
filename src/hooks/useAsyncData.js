import { useCallback, useEffect, useRef, useState } from 'react'

export default function useAsyncData(key, asyncFn) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const fnRef = useRef(asyncFn)
  fnRef.current = asyncFn

  const load = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      setData(await fnRef.current())
    } catch (e) {
      setError(e?.message || 'حدث خطأ غير متوقع')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    setData(null)
    load()
  }, [key, load])

  return { data, error, isLoading, reload: load }
}
