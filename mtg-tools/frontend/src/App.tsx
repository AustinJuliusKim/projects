import { useCallback, useEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router'
import {
  ActionIcon,
  AppShell,
  Button,
  Group,
  Skeleton,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'

import { api, ApiError, type Operation } from './api/client'
import { Collection } from './routes/Collection'
import { Imports } from './routes/Imports'
import { Review } from './routes/Review'
import { History } from './routes/History'
import { ExportPanel, Sell } from './routes/Sell'
import { Sealed } from './routes/Sealed'
import { ChartsSkeleton, HeroSkeleton } from './components/Skeletons'

/** Anything that changes data bumps this so views refetch. */
export const useRevision = () => {
  const [revision, setRevision] = useState(0)
  return { revision, bump: useCallback(() => setRevision((n) => n + 1), []) }
}

export function App() {
  const [ready, setReady] = useState(false)
  const [undoable, setUndoable] = useState<Operation | null>(null)
  const [revision, setRevision] = useState(0)
  const location = useLocation()

  const bump = useCallback(() => setRevision((n) => n + 1), [])

  const refreshSession = useCallback(async () => {
    const session = await api.session()
    setUndoable(session.undoable)
  }, [])

  useEffect(() => {
    api
      .session()
      .then((session) => {
        setUndoable(session.undoable)
        setReady(true)
      })
      .catch(() => setReady(true))
  }, [])

  useEffect(() => {
    if (ready) void refreshSession()
  }, [ready, revision, location.pathname, refreshSession])

  const undo = async () => {
    try {
      const operation = await api.undo()
      notifications.show({ message: `Undone: ${operation.summary}`, color: 'blue' })
      bump()
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Undo failed',
        color: 'red',
      })
    }
  }

  if (!ready) {
    // A centred spinner reserves no space, so the whole layout snaps into
    // place once the session resolves. The chrome is static — render it.
    return (
      <AppShell header={{ height: 56 }} padding="md">
        <AppShell.Header>
          <Group h="100%" px="md" gap="lg">
            <Title order={5} c="bronze.6">
              ✦ mtg-tools
            </Title>
            {[70, 52, 40, 58].map((width, i) => (
              <Skeleton key={i} height={11} width={width} radius="sm" />
            ))}
          </Group>
        </AppShell.Header>
        <AppShell.Main>
          <HeroSkeleton />
          <ChartsSkeleton />
        </AppShell.Main>
      </AppShell>
    )
  }

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" gap="lg">
          <Text fw={650}>mtg-tools</Text>
          {[
            ['/', 'Collection'],
            ['/sealed', 'Sealed'],
            ['/imports', 'Import'],
            ['/sell', 'Sell'],
            ['/history', 'History'],
          ].map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              style={({ isActive }) => ({
                textDecoration: 'none',
                color: isActive
                  ? 'var(--mantine-color-text)'
                  : 'var(--mantine-color-dimmed)',
                fontWeight: isActive ? 600 : 400,
                fontSize: 14,
              })}
            >
              {label}
            </NavLink>
          ))}

          <Group ml="auto" gap="xs">
            {undoable && (
              <Tooltip label={undoable.summary} withArrow>
                <Button variant="default" size="xs" onClick={undo}>
                  ↶ Undo
                </Button>
              </Tooltip>
            )}
            <ThemeToggle />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Routes>
          <Route path="/" element={<Collection revision={revision} onChange={bump} />} />
          <Route
            path="/sealed"
            element={<Sealed revision={revision} onChange={bump} />}
          />
          <Route path="/imports" element={<Imports onChange={bump} />} />
          <Route path="/imports/:id" element={<Review onChange={bump} />} />
          <Route path="/sell" element={<Sell revision={revision} onChange={bump} />} />
          <Route
            path="/history"
            element={
              <>
                <History revision={revision} />
                <ExportPanel />
              </>
            }
          />
        </Routes>
      </AppShell.Main>
    </AppShell>
  )
}

function ThemeToggle() {
  const { setColorScheme } = useMantineColorScheme()
  const computed = useComputedColorScheme('light', { getInitialValueInEffect: true })
  return (
    <Tooltip label={computed === 'dark' ? 'Light mode' : 'Dark mode'} withArrow>
      <ActionIcon
        variant="default"
        size="lg"
        aria-label="Toggle color scheme"
        onClick={() => setColorScheme(computed === 'dark' ? 'light' : 'dark')}
      >
        {computed === 'dark' ? '☀' : '☾'}
      </ActionIcon>
    </Tooltip>
  )
}
