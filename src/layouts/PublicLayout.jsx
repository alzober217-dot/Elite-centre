import { Outlet } from 'react-router-dom'
import Header from '../components/Header.jsx'
import Footer from '../components/Footer.jsx'
import MobileTabBar from '../components/MobileTabBar.jsx'
import { useLocale } from '../contexts/LocaleContext.jsx'

export default function PublicLayout() {
  const { t } = useLocale()
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main-content">{t('تجاوز إلى المحتوى')}</a>
      <Header />
      <main id="main-content" className="public-main" tabIndex="-1"><Outlet /></main>
      <Footer />
      <MobileTabBar />
    </div>
  )
}