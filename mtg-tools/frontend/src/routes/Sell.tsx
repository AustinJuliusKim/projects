import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  SimpleGrid,
  Skeleton,
  Table,
  Text,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'

import {
  api,
  ApiError,
  type BuylistSummary,
  type QueueItem,
  type SaleRecord,
  type SalesSummary,
} from '../api/client'
import { downloadProps } from '../api/download'
import { useResource } from '../components/useResource'
import {
  Refetching,
  StatsSkeleton,
  TableSkeleton,
} from '../components/Skeletons'

/**
 * The sale lifecycle: listed → sold → fees → net → realized gain.
 *
 * The queue is driven by verdicts, so triage in the collection view feeds
 * straight into here — they are not two separate piles to keep in sync.
 */
export function Sell({ revision, onChange }: { revision: number; onChange: () => void }) {
  const [selling, setSelling] = useState<QueueItem | null>(null)
  const [tick, setTick] = useState(0)

  const resource = useResource<{
    queue: QueueItem[]
    sales: SaleRecord[]
    summary: SalesSummary
  }>(
    async () => {
      const [queue, sales, summary] = await Promise.all([
        api.salesQueue(),
        api.sales(),
        api.salesSummary(),
      ])
      return { queue, sales, summary }
    },
    [revision, tick],
  )

  const { showSkeleton, refetching } = resource
  const queue = resource.data?.queue ?? []
  const sales = resource.data?.sales ?? []
  const summary = resource.data?.summary ?? null
  const load = useCallback(() => setTick((n) => n + 1), [])

  const list = async (item: QueueItem) => {
    try {
      await api.listForSale({ kind: item.kind, id: item.id })
      notifications.show({ message: `Listed ${item.name}.`, color: 'blue' })
      onChange()
      void load()
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Could not list',
        color: 'red',
      })
    }
  }

  return (
    <>
      <Title order={2} fz="xl">
        Sell
      </Title>
      <Text c="dimmed" fz="sm" mb="md">
        Everything marked <b>sell</b> in the collection shows up here. Recording a
        sale removes it from the collection, so valuations stay honest afterwards.
      </Text>

      {showSkeleton && <StatsSkeleton count={4} />}

      {summary && (
        <SimpleGrid cols={{ base: 2, sm: 4 }} mb="md">
          <Stat label="Listed" value={summary.listed} sub={`${summary.listedCount} open`} />
          <Stat label="Gross" value={summary.gross} sub={`${summary.soldCount} sold`} />
          <Stat label="Fees & shipping" value={summary.costs} />
          <Stat label="Net proceeds" value={summary.net} />
        </SimpleGrid>
      )}

      {summary && summary.soldCount > 0 && (
        <Alert mb="md" color={summary.gainKnownFor ? 'blue' : 'orange'}>
          {summary.gainKnownFor === 0 ? (
            <>
              Realized gain is unknown — none of the {summary.soldCount} sold rows
              had a cost basis. Nothing has been assumed; a fabricated basis would
              turn straight into a tax figure.
            </>
          ) : (
            <>
              Realized gain <b>{summary.realizedGain}</b>, covering{' '}
              {summary.gainKnownFor} of {summary.soldCount} sold rows — the rest
              have no cost basis recorded.
            </>
          )}
        </Alert>
      )}

      <Title order={3} fz="md" mb="xs">
        Queue
      </Title>
      <Card withBorder padding={0} radius="md" mb="lg">
        {showSkeleton ? <TableSkeleton rows={4} columns={6} /> : (
        <Refetching active={refetching}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              {['Card', 'Set', 'Qty', 'Market', 'State', ''].map((h) => (
                <Table.Th key={h}>{h}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {queue.map((item) => (
              <Table.Tr key={`${item.kind}-${item.id}`}>
                <Table.Td fw={550}>{item.name}</Table.Td>
                <Table.Td c="dimmed">{item.setCode}</Table.Td>
                <Table.Td ta="right" ff="monospace">
                  ×{item.quantity}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  ${(item.marketCents / 100).toFixed(2)}
                </Table.Td>
                <Table.Td>
                  {item.sale ? (
                    <Badge size="sm" color={item.sale.status === 'sold' ? 'teal' : 'blue'}>
                      {item.sale.status}
                    </Badge>
                  ) : (
                    <Badge size="sm" variant="light" color="gray">
                      not listed
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  {!item.sale && (
                    <Button size="xs" variant="light" onClick={() => list(item)}>
                      List
                    </Button>
                  )}
                  {item.sale?.status === 'listed' && (
                    <Group gap={6}>
                      <Button size="xs" onClick={() => setSelling(item)}>
                        Record sale
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={async () => {
                          await api.cancelSale(item.sale!.id)
                          onChange()
                          void load()
                        }}
                      >
                        Cancel
                      </Button>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {!queue.length && (
          <Text c="dimmed" ta="center" p="xl">
            Nothing marked to sell yet. Mark rows in the collection view.
          </Text>
        )}
        </Refetching>
        )}
      </Card>

      <BuylistPanel revision={revision} />

      <Title order={3} fz="md" mb="xs">
        Sold
      </Title>
      <Card withBorder padding={0} radius="md">
        {showSkeleton ? <TableSkeleton rows={3} columns={7} /> : (
        <Refetching active={refetching}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              {['When', 'Item', 'Qty', 'Sold', 'Fees', 'Net', 'Gain'].map((h) => (
                <Table.Th key={h}>{h}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sales
              .filter((s) => s.status === 'sold')
              .map((sale) => (
                <Table.Tr key={sale.id}>
                  <Table.Td c="dimmed" fz="xs">
                    {(sale.sold_at ?? '').slice(0, 10)}
                  </Table.Td>
                  <Table.Td fw={550}>{sale.name ?? '(no longer held)'}</Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    ×{sale.quantity}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {money(sale.sold_cents)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {money(sale.fees_cents + sale.shipping_cents)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" fw={600}>
                    {money(sale.net_cents)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {/* Blank, not zero: no cost basis means unknown. */}
                    {sale.realized_gain_cents === null
                      ? '—'
                      : money(sale.realized_gain_cents)}
                  </Table.Td>
                </Table.Tr>
              ))}
          </Table.Tbody>
        </Table>
        {!sales.some((s) => s.status === 'sold') && (
          <Text c="dimmed" ta="center" p="xl">
            Nothing sold yet.
          </Text>
        )}
        </Refetching>
        )}
      </Card>

      <RecordSale
        item={selling}
        onClose={() => setSelling(null)}
        onDone={() => {
          setSelling(null)
          onChange()
          void load()
        }}
      />
    </>
  )
}

function RecordSale({
  item,
  onClose,
  onDone,
}: {
  item: QueueItem | null
  onClose: () => void
  onDone: () => void
}) {
  const [sold, setSold] = useState<string | number>('')
  const [fees, setFees] = useState<string | number>('')
  const [shipping, setShipping] = useState<string | number>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (item) setSold((item.marketCents / 100).toFixed(2))
  }, [item])

  const submit = async () => {
    if (!item?.sale) return
    setBusy(true)
    try {
      const result = await api.recordSale(item.sale.id, {
        sold: String(sold),
        fees: String(fees || '0'),
        shipping: String(shipping || '0'),
      })
      notifications.show({
        message:
          `Recorded. Net ${result.net}` +
          (result.removedFromCollection ? ' · removed from the collection.' : '.'),
        color: 'teal',
      })
      onDone()
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Could not record',
        color: 'red',
      })
    } finally {
      setBusy(false)
    }
  }

  const net =
    (Number(sold) || 0) - (Number(fees) || 0) - (Number(shipping) || 0)

  return (
    <Modal opened={item !== null} onClose={onClose} title={`Sold: ${item?.name ?? ''}`}>
      <NumberInput
        label="Sale price"
        prefix="$"
        decimalScale={2}
        value={sold}
        onChange={setSold}
        mb="xs"
      />
      <Group grow mb="xs">
        <NumberInput
          label="Fees"
          prefix="$"
          decimalScale={2}
          value={fees}
          onChange={setFees}
        />
        <NumberInput
          label="Shipping"
          prefix="$"
          decimalScale={2}
          value={shipping}
          onChange={setShipping}
        />
      </Group>

      <Text fz="sm" mb="md">
        Net proceeds <b>${net.toFixed(2)}</b>
        {item?.costBasisCents == null && (
          <Text span c="dimmed" fz="xs">
            {' '}
            · no cost basis recorded, so realized gain stays blank
          </Text>
        )}
      </Text>

      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={busy} onClick={submit}>
          Record sale
        </Button>
      </Group>
    </Modal>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card withBorder padding="sm" radius="md">
      <Text c="dimmed" fz="xs" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text fz="xl" fw={650}>
        {value}
      </Text>
      {sub && (
        <Text c="dimmed" fz="xs">
          {sub}
        </Text>
      )}
    </Card>
  )
}

const money = (cents: number | null) =>
  cents === null ? '—' : `$${(cents / 100).toFixed(2)}`

/**
 * The vendor submission list.
 *
 * Deliberately here rather than in "Export everything": that panel is a backup,
 * this is a step in the sell workflow. It reads from the same verdicts the
 * queue above does, so the shipment and the queue can't disagree.
 */
function BuylistPanel({ revision }: { revision: number }) {
  const [summary, setSummary] = useState<BuylistSummary | null>(null)

  useEffect(() => {
    api.buylistSummary().then(setSummary).catch(() => undefined)
  }, [revision])

  const empty = summary?.rows === 0

  return (
    <Card withBorder radius="md" mb="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Title order={3} fz="md">
            Card Kingdom submission list
          </Title>
          <Text c="dimmed" fz="sm">
            {summary === null ? (
              <Skeleton height={12} width={320} radius="sm" mt={6} />
            ) : empty ? (
              'Nothing to submit yet — mark rows sell in the collection first.'
            ) : (
              <>
                {summary.rows} stacks · {summary.quantity} cards ·{' '}
                <b>{summary.market}</b> at market, an estimated{' '}
                <b>{summary.cash}</b> cash or <b>{summary.credit}</b> credit.
              </>
            )}
          </Text>
        </div>
        {/* A `disabled` anchor is not disabled — it still navigates, and only
            looks inert because of styling. With nothing marked sell that means
            downloading a lone header row. So render real buttons when there
            is nothing to fetch, and links only when there is. */}
        {summary === null || empty ? (
          <Group gap="xs" wrap="nowrap">
            <Button variant="filled" disabled>
              Card Kingdom CSV
            </Button>
            <Button variant="default" disabled>
              Detailed CSV
            </Button>
          </Group>
        ) : (
          <Group gap="xs" wrap="nowrap">
            <Button
              variant="filled"
              {...downloadProps('buylist-ck', '/api/export/buylist/ck')}
            >
              Card Kingdom CSV
            </Button>
            <Button variant="default" {...downloadProps('buylist', '/api/export/buylist')}>
              Detailed CSV
            </Button>
          </Group>
        )}
      </Group>
      {summary !== null && !empty && (
        <Text c="dimmed" fz="xs" mt="sm">
          The Card Kingdom file carries only the four columns their importer
          accepts (Card Name, Edition, Foil, Quantity); the detailed file keeps
          prices, condition and language for every other destination. Both list
          the same cards. Sub-$1 cards are left off — a vendor pays close to
          nothing for them and they inflate the shipment. Cards already listed
          or sold are excluded so nothing gets sold twice. The cash and credit
          figures are this project's fixed rate bands, not CK's per-card offers:
          a planning number, not a quote.
        </Text>
      )}
    </Card>
  )
}

/** Download everything. The database is canonical now; this is the way out. */
export function ExportPanel() {
  const [manifest, setManifest] = useState<Awaited<
    ReturnType<typeof api.exportManifest>
  > | null>(null)

  useEffect(() => {
    api.exportManifest().then(setManifest).catch(() => undefined)
  }, [])

  return (
    <Card withBorder radius="md" mt="lg">
      <Title order={3} fz="md">
        Export everything
      </Title>
      <Text c="dimmed" fz="sm" mb="sm">
        The database is the system of record now. This is the way back out —
        every table as CSV, the tax/insurance ledger, and a copy of the database
        itself.
      </Text>
      <Group>
        <Button {...downloadProps('bundle', '/api/export/bundle')}>
          Download bundle (.zip)
        </Button>
        <Button variant="default" {...downloadProps('ledger', '/api/export/ledger')}>
          Ledger CSV
        </Button>
        {manifest && (
          <Text c="dimmed" fz="xs">
            {manifest.rowCounts.holdings ?? 0} holdings ·{' '}
            {manifest.rowCounts.sales ?? 0} sales · {manifest.singles.value}
          </Text>
        )}
      </Group>
    </Card>
  )
}
