import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge, Button, Card, Group, Table, Text, Title } from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import { notifications } from '@mantine/notifications'
import { api, ApiError, type ImportRecord } from '../api/client'
import { useResource } from '../components/useResource'
import { Refetching, TableSkeleton } from '../components/Skeletons'

export function Imports({ onChange }: { onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const navigate = useNavigate()

  const { data, showSkeleton, refetching } = useResource<ImportRecord[]>(
    () => api.imports(),
    [revision],
  )
  const rows = data ?? []
  const load = () => setRevision((n) => n + 1)

  const upload = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    try {
      const { importId, kind } = await api.upload(files[0])
      notifications.show({
        message: `Staged ${kind} import — nothing has changed yet.`, color: 'blue',
      })
      onChange()
      load()
      navigate(`/imports/${importId}`)
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Upload failed',
        color: 'red', autoClose: 8000,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Title order={2} fz="xl">Import a CSV</Title>
      <Text c="dimmed" fz="sm" mb="md">
        ManaBox exports (either header dialect) and sealed lists are both
        recognized. Nothing touches your collection until you review and commit.
      </Text>

      <Dropzone onDrop={upload} loading={busy} accept={['text/csv']} mb="md" maxSize={25 * 1024 ** 2}>
        <Group justify="center" mih={90} style={{ pointerEvents: 'none' }}>
          <Text c="dimmed">Drop a CSV here, or click to choose one</Text>
        </Group>
      </Dropzone>

      <Card withBorder padding={0} radius="md">
        {showSkeleton ? <TableSkeleton rows={4} columns={6} /> : (
        <Refetching active={refetching}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              {['File', 'Kind', 'Dialect', 'Rows', 'Status', 'When', ''].map((h) => (
                <Table.Th key={h}>{h}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td fw={550}>{row.filename}</Table.Td>
                <Table.Td>{row.kind}</Table.Td>
                <Table.Td c="dimmed" fz="xs">{row.dialect}</Table.Td>
                <Table.Td ta="right" ff="monospace">{row.rowCount}</Table.Td>
                <Table.Td>
                  <Badge size="sm" variant={row.status === 'staged' ? 'filled' : 'light'}
                         color={row.status === 'committed' ? 'teal' : row.status === 'staged' ? 'blue' : 'gray'}>
                    {row.status}
                  </Badge>
                </Table.Td>
                <Table.Td c="dimmed" fz="xs">
                  {(row.committedAt ?? row.createdAt).slice(0, 16).replace('T', ' ')}
                </Table.Td>
                <Table.Td>
                  {row.status === 'staged' && (
                    <Button size="xs" variant="subtle"
                            onClick={() => navigate(`/imports/${row.id}`)}>
                      review →
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {!rows.length && <Text c="dimmed" ta="center" p="xl">No imports yet.</Text>}
        </Refetching>
        )}
      </Card>
    </>
  )
}
