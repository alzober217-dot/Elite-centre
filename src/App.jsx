import { useState } from 'react'
import AppRouter from './app/AppRouter.jsx'
import { LocaleProvider } from './contexts/LocaleContext.jsx'
import Splash from './components/Splash.jsx'

export default function App() {
  const [ready, setReady] = useState(false)

  if (!ready) return <Splash onFinish={() => setReady(true)} />

  return <LocaleProvider><AppRouter /></LocaleProvider>
}
