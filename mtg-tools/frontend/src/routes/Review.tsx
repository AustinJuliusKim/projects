import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Alert, Badge, Button, Card, Group, Select, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { api, ApiError, type ImportDetail } from '../api/client'
import { useResource } from '../components/useResource'
import { IssuesSkeleton, Refetching } from '../components/Skeletons'
import { Skeleton } from '@mantine/core'

export function Review({ onChange }: { onChange: () => void }) {
  const { id } = useParams()
  const importId = Number(id)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const navigate = useNavigate()

  const { data: detail, showSkeleton, refetching } = useResource<ImportDetail>(
    () => api.importDetail(importId),
    [importId, revision],
  )
  const load = useCallback(() => setRevision((n) => n + 1), [])

  // Previously returned null here, so the screen was simply blank while the
  // request was in flight.
  if (showSkeleton || !detail) {
    return (
      <>
        <Skeleton height={24} width={260} radius="sm" mb={8} />
        <Skeleton height={12} width={380} radius="sm" mb="md" />
        <Skeleton height={58} radius="md" mb="md" />
        <Skeleton height={34} width={280} radius="sm" mb="md" />
        <IssuesSkeleton />
      </>
    )
  }

  const { record, blocking } = detail

  // Where a finished import should land you. A commit used to send everyone to
  // '/' regardless of kind, so importing a sealed list dropped you on the
  // singles collection with nothing changed — indistinguishable from an import
  // that did nothing. Send people to the screen their rows actually went to.
  const committed = record.kind === 'sealed' ? '/sealed' : '/'

  const act = async (fn: () => Promise<unknown>, message: string, to: string) => {
    setBusy(true)
    try {
      await fn()
      notifications.show({ message, color: 'blue' })
      onChange()
      navigate(to)
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Failed',
        color: 'red', autoClose: 8000,
      })
    } finally { setBusy(false) }
  }

  return (
    <>
      <Title order={2} fz="xl">{record.filename}</Title>
      <Text c="dimmed" fz="sm" mb="md">
        {record.rowCount} rows · {record.kind} · {record.dialect} ·{' '}
        <b>staged</b> — your collection is unchanged so far.
      </Text>

      <Alert mb="md" color={blocking ? 'orange' : 'teal'}
             title={blocking ? `${blocking} row(s) need a decision` : 'Nothing is blocking'}>
        {blocking
          ? 'Resolve or skip them before committing. Everything else is advisory.'
          : 'Ready to commit.'}
      </Alert>

      <Group mb="md">
        <Button disabled={blocking > 0} loading={busy}
                onClick={() => act(() => api.commitImport(importId), 'Committed. Undo is available.', committed)}>
          Commit {record.rowCount} rows
        </Button>
        <Button variant="default" loading={busy}
                onClick={() => act(() => api.discardImport(importId), 'Discarded. Your collection was never touched.', '/imports')}>
          Discard
        </Button>
      </Group>

      <Refetching active={refetching}>
      {detail.issues.map((issue) => (
        <Card key={issue.code} withBorder mb="sm" padding="sm"
              style={issue.blocking ? { borderLeft: '3px solid var(--mantine-color-orange-6)' } : undefined}>
          <Group gap="xs" mb={6}>
            <Text fw={600} fz="sm">{issue.code}</Text>
            <Text c="dimmed" fz="xs">({issue.rows.length} row{issue.rows.length === 1 ? '' : 's'})</Text>
            {issue.blocking && <Badge size="xs" color="orange">blocks commit</Badge>}
          </Group>
          {issue.rows.slice(0, 25).map((row) => (
            <Group key={row.id} gap="sm" py={4} wrap="nowrap"
                   style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
              <Text fz="xs" c="dimmed" w={54}>line {row.lineNo}</Text>
              <Text fz="sm" style={{ flex: 1 }}>
                {row.name || '—'}
                {row.candidates.length > 0 && (
                  <Text span c="dimmed" fz="xs"> — could be {row.candidates.join(' or ')}</Text>
                )}
              </Text>
              {issue.blocking && row.state !== 'skipped' ? (
                <Group gap={6} wrap="nowrap">
                  {row.candidates.length > 0 && (
                    <Select size="xs" w={140} placeholder="pick a set"
                            data={row.candidates.map((c) => ({ value: c.split(' ')[0], label: c }))}
                            onChange={(setCode) => setCode && api
                              .resolveRow(importId, row.id, { set_code: setCode })
                              .then(load)} />
                  )}
                  <Button size="xs" variant="subtle"
                          onClick={() => api.resolveRow(importId, row.id, { skip: true }).then(load)}>
                    Skip
                  </Button>
                </Group>
              ) : (
                <Badge size="xs" variant="light">{row.state}</Badge>
              )}
            </Group>
          ))}
          {issue.rows.length > 25 && (
            <Text c="dimmed" fz="xs" mt={6}>…and {issue.rows.length - 25} more.</Text>
          )}
        </Card>
      ))}
      {!detail.issues.length && <Text c="dimmed">No issues found in this file.</Text>}
      </Refetching>
    </>
  )
}
