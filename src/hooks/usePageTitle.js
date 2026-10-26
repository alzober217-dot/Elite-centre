import { useEffect } from 'react'
import { useLocale } from '../contexts/LocaleContext.jsx'

export default function usePageTitle(title) {
  const { t } = useLocale()
  useEffect(() => { document.title = title ? `${t(title)} | ${t('مركز النخبة')}` : t('مركز النخبة') }, [title, t])
}