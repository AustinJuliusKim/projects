import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'

import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/dropzone/styles.css'
import '@mantine/charts/styles.css'
import 'mantine-datatable/styles.css'

import { App } from './App'
import { LocalGuard } from './local/LocalGuard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* `auto` follows the OS; the header exposes a toggle that overrides it. */}
    <MantineProvider defaultColorScheme="auto">
      <Notifications position="bottom-right" />
      <BrowserRouter>
        <LocalGuard>
          <App />
        </LocalGuard>
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>,
)
