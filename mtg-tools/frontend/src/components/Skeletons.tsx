import { Card, Group, Skeleton, SimpleGrid, Stack, Table } from '@mantine/core'

/**
 * Placeholders shaped like the content they stand in for.
 *
 * The point of a skeleton is to reserve the right space, so nothing jumps when
 * real data lands. A generic spinner does the opposite: it occupies no space,
 * then the layout snaps into place around it.
 *
 * These only ever render on **first** load — see `useResource`. A refetch keeps
 * the previous render and dims it, because the collection view refetches on
 * every filter keystroke and flashing grey bars each time would be worse than
 * the wait.
 */

export function TableSkeleton({
  rows = 8,
  columns = 5,
}: {
  rows?: number
  columns?: number
}) {
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          {Array.from({ length: columns }).map((_, i) => (
            <Table.Th key={i}>
              <Skeleton height={10} width={i === 0 ? 90 : 54} radius="sm" />
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {Array.from({ length: rows }).map((_, row) => (
          <Table.Tr key={row}>
            {Array.from({ length: columns }).map((_, col) => (
              <Table.Td key={col}>
                <Skeleton
                  height={9}
                  // Varied widths so it reads as text rather than a barcode.
                  width={col === 0 ? `${58 + ((row * 13) % 34)}%` : 52}
                  radius="sm"
                />
              </Table.Td>
            ))}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}

export function HeroSkeleton() {
  return (
    <Stack gap={6} mb="md">
      <Skeleton height={10} width={110} radius="sm" />
      <Skeleton height={38} width={210} radius="sm" />
      <Skeleton height={11} width={330} radius="sm" />
    </Stack>
  )
}

export function ChartsSkeleton() {
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="md">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card withBorder padding="md" radius="md" key={i}>
          <Group justify="space-between" mb={4}>
            <Skeleton height={11} width={140} radius="sm" />
            <Skeleton height={22} width={92} radius="sm" />
          </Group>
          <Skeleton height={9} width={220} radius="sm" mb="sm" />
          {/* Matches the 200–240px plot area, so the grid doesn't resize. */}
          <Skeleton height={i === 2 ? 240 : 200} radius="sm" />
        </Card>
      ))}
    </SimpleGrid>
  )
}

export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SimpleGrid cols={{ base: 2, sm: count }} mb="md">
      {Array.from({ length: count }).map((_, i) => (
        <Card withBorder padding="sm" radius="md" key={i}>
          <Skeleton height={9} width={68} radius="sm" mb={8} />
          <Skeleton height={22} width={104} radius="sm" />
        </Card>
      ))}
    </SimpleGrid>
  )
}

export function IssuesSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <>
      {Array.from({ length: blocks }).map((_, i) => (
        <Card withBorder mb="sm" padding="sm" key={i}>
          <Skeleton height={11} width={170} radius="sm" mb={10} />
          {Array.from({ length: 3 }).map((__, row) => (
            <Group key={row} gap="sm" py={5}>
              <Skeleton height={9} width={44} radius="sm" />
              <Skeleton height={9} width={`${40 + ((row * 17) % 30)}%`} radius="sm" />
            </Group>
          ))}
        </Card>
      ))}
    </>
  )
}

/** Wraps content being refetched: visible, readable, clearly not final. */
export function Refetching({
  active,
  children,
}: {
  active: boolean
  children: React.ReactNode
}) {
  return (
    <div
      aria-busy={active}
      style={{
        opacity: active ? 0.55 : 1,
        transition: 'opacity 140ms ease',
        pointerEvents: active ? 'none' : undefined,
      }}
    >
      {children}
    </div>
  )
}
