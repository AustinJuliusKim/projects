/**
 * The local-backend shell: everything browser storage needs that a server
 * never did. Renders children untouched on the http backend.
 *
 * - **One tab owns the database.** A Web Lock is held for the tab's lifetime;
 *   a second tab gets a "collection is open in another tab" screen with a
 *   retry. (The SAHPool VFS physically cannot open twice — the lock turns
 *   that hard failure into an explanation.)
 * - **Durability is asked for, and reported honestly.** `storage.persist()`
 *   is requested once; the status line says whether the browser promised to
 *   keep the data or may evict it — either way the export bundle is the real
 *   backup, and a nudge appears when there hasn't been one for a while.
 * - **First run offers a way in**: import a server install's collection.db,
 *   start from a CSV, or start empty.
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert, Anchor, Button, Card, FileButton, Group, Stack, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'

import { api } from '../api/client'
import { saveDownload } from '../api/download'
import { importLocalDatabase } from '../api/transport-local'

export const useLocal = import.meta.env.VITE_BACKEND === 'local'
const LOCK = 'mtg-tools-db'
export const LAST_BUNDLE_KEY = 'mtg-tools-last-bundle-export'
const DISMISS_KEY = 'mtg-tools-first-run-dismissed'
const NUDGE_DAYS = 30

// Module-level singleton: React StrictMode double-mounts effects in dev, and
// two concurrent ifAvailable requests would false-block the second.
let lockAttempt: Promise<boolean> | null = null

function requestLock(): Promise<boolean> {
  if (!lockAttempt) {
    lockAttempt = new Promise((resolve) => {
      void navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
        if (lock === null) {
          lockAttempt = null // allow a retry
          resolve(false)
          return
        }
        resolve(true)
        // Hold the lock until the tab dies.
        await new Promise(() => {})
      })
    })
  }
  return lockAttempt
}

export function LocalGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'acquiring' | 'blocked' | 'owned'>(
    useLocal ? 'acquiring' : 'owned',
  )

  const acquire = useCallback(() => {
    if (!useLocal) return
    setState('acquiring')
    void requestLock().then((owned) => setState(owned ? 'owned' : 'blocked'))
  }, [])

  useEffect(() => acquire(), [acquire])

  if (state === 'blocked') {
    return (
      <Card withBorder maw={480} mx="auto" mt="15vh" p="lg">
        <Title order={3}>The collection is open in another tab</Title>
        <Text c="dimmed" fz="sm" mt="xs">
          Browser storage has one writer, same as the old local server had. Close
          the other tab (or stop using it), then try again here.
        </Text>
        <Button mt="md" onClick={acquire}>
          Try again
        </Button>
      </Card>
    )
  }
  if (state === 'acquiring') return null
  return <>{children}</>
}

// Rendered by App inside AppShell.Main, not here — LocalGuard wraps the
// whole app from outside AppShell (it needs to gate the tab lock before
// anything, including the header, mounts), but these alerts need to
// participate in AppShell's own layout to land below the fixed header
// rather than being covered by it.
export function LocalStatus() {
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [firstRun, setFirstRun] = useState(false)
  const [rows, setRows] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      // Ask once; report honestly. Denied is not an error — it means the
      // bundle export matters more.
      try {
        await navigator.storage.persist()
        setPersisted(await navigator.storage.persisted())
      } catch {
        setPersisted(null)
      }
      try {
        const [collection, imports] = await Promise.all([api.collection({}), api.imports()])
        setRows(collection.grandTotals.rows)
        setFirstRun(
          collection.grandTotals.rows === 0 &&
            imports.length === 0 &&
            !localStorage.getItem(DISMISS_KEY),
        )
      } catch {
        setFirstRun(false)
      }
    })()
  }, [])

  const importDb = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    try {
      const result = await importLocalDatabase(file)
      notifications.show({
        message: `Imported ${result.holdings} holdings and ${result.sealed} sealed rows.`,
        color: 'blue',
      })
      window.location.reload()
    } catch (error) {
      notifications.show({ message: (error as Error).message, color: 'red' })
      setBusy(false)
    }
  }

  const lastBundle = localStorage.getItem(LAST_BUNDLE_KEY)
  const staleBundle =
    rows !== null &&
    rows > 0 &&
    (!lastBundle ||
      Date.now() - new Date(lastBundle).getTime() > NUDGE_DAYS * 24 * 3600 * 1000)

  return (
    <>
      {firstRun && (
        <Alert m="md" mb={0} title="Your collection lives in this browser now" color="blue">
          <Stack gap="xs">
            <Text fz="sm">
              Everything is stored locally (nothing leaves this machine). Three
              ways to begin: bring over a server install&apos;s database, import a
              ManaBox CSV on the <Anchor href="/imports">Import screen</Anchor>,
              or just start empty.
            </Text>
            <Group gap="xs">
              <FileButton onChange={importDb} accept=".db,.sqlite,.sqlite3">
                {(props) => (
                  <Button size="xs" loading={busy} {...props}>
                    Import collection.db
                  </Button>
                )}
              </FileButton>
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  localStorage.setItem(DISMISS_KEY, '1')
                  setFirstRun(false)
                }}
              >
                Start empty
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {persisted === false && rows !== null && rows > 0 && (
        <Alert m="md" mb={0} color="orange" title="The browser may evict this data">
          Persistent storage was not granted, so the browser is allowed to
          reclaim this database under disk pressure. Export a bundle regularly —
          it contains the complete database.
        </Alert>
      )}
      {staleBundle && persisted !== false && (
        <Alert m="md" mb={0} color="yellow" title="No recent backup">
          {lastBundle
            ? `The last export bundle was ${Math.floor((Date.now() - new Date(lastBundle).getTime()) / 86400000)} days ago.`
            : 'No export bundle has been downloaded from this browser yet.'}{' '}
          Browser storage is durable-with-a-promise; the bundle is the copy you
          actually control.{' '}
          <Anchor
            fz="sm"
            onClick={() => void saveDownload('bundle')}
          >
            Download one now
          </Anchor>
          .
        </Alert>
      )}
    </>
  )
}
