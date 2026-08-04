import { Alert, Badge, Card, Table, Text, Title } from '@mantine/core'
import { api, type Operation } from '../api/client'
import { useResource } from '../components/useResource'
import { Refetching, TableSkeleton } from '../components/Skeletons'

export function History({ revision }: { revision: number }) {
  const { data, error, showSkeleton, refetching } = useResource<Operation[]>(
    () => api.history(),
    [revision],
  )

  return (
    <>
      <Title order={2} fz="xl">History</Title>
      <Text c="dimmed" fz="sm" mb="md">
        Every change is reversible, newest first. Undo works newest-first so the
        result always matches this log.
      </Text>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      <Card withBorder padding={0} radius="md">
        {showSkeleton ? (
          <TableSkeleton rows={6} columns={4} />
        ) : (
          <Refetching active={refetching}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  {['When', 'Change', 'Rows', 'State'].map((h) => (
                    <Table.Th key={h}>{h}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(data ?? []).map((op) => (
                  <Table.Tr key={op.id} opacity={op.reverted ? 0.55 : 1}>
                    <Table.Td c="dimmed" fz="xs">
                      {op.createdAt.slice(0, 16).replace('T', ' ')}
                    </Table.Td>
                    <Table.Td fw={550}>{op.summary}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{op.affected}</Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant={op.reverted ? 'light' : 'filled'}
                             color={op.reverted ? 'gray' : 'blue'}>
                        {op.reverted ? 'undone' : 'applied'}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {data?.length === 0 && (
              <Text c="dimmed" ta="center" p="xl">Nothing has changed yet.</Text>
            )}
          </Refetching>
        )}
      </Card>
    </>
  )
}
