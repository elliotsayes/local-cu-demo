import './App.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Demo } from './Demo'

function App() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <Demo />
    </QueryClientProvider>
  )
}

export default App
