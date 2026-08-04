import { useCallback, useEffect, useMemo, useState } from 'react'
import { DataTable, type DataTableSortStatus } from 'mantine-datatable'
import { BarChart } from '@mantine/charts'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  Paper,
  Progress,
  Select,
  SimpleGrid,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useDebouncedValue } from '@mantine/hooks'

import {
  api,
  ApiError,
  type BulkAction,
  type Filters,
  type SealedInsights,
  type SealedPage,
  type SealedRow,
} from '../api/client'
import { downloadProps } from '../api/download'
import { useSelection } from '../components/useSelection'
import { ChartsSkeleton, HeroSkeleton, Refetching } from '../components/Skeletons'

const PER_PAGE = 50

/**
 * Sealed products — previously importable but unreachable.
 *
 * Deliberately not a copy of the singles view. There are **no Card Kingdom rate
 * bands**: those are CK's singles buylist rates and sealed isn't going to CK, so
 * applying them would print a figure matching no real offer. Price coverage
 * takes their place, because with hand-entered prices a partial valuation is the
 * normal state rather than an error.
 */
export function Sealed({
  revision,
  onChange,
}: {
  revision: number
  onChange: () => void
}) {
  const [setCode, setSetCode] = useState<string | null>(null)
  const [year, setYear] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [unpriced, setUnpriced] = useState(false)
  const [name, setName] = useState('')
  const [debouncedName] = useDebouncedValue(name, 250)

  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<DataTableSortStatus<SealedRow>>({
    columnAccessor: 'total',
    direction: 'desc',
  })

  const [data, setData] = useState<SealedPage | null>(null)
  const [insights, setInsights] = useState<SealedInsights | null>(null)
  const [actions, setActions] = useState<BulkAction[]>([])
  const [loading, setLoading] = useState(true)

  const firstLoad = loading && data === null
  const refetching = loading && data !== null

  const filters: Filters = useMemo(() => {
    const out: Filters = {}
    if (setCode) out.set_code = setCode
    if (year) out.year = year
    if (verdict) out.verdict = verdict
    if (unpriced) out.unpriced = '1'
    if (debouncedName) out.name_contains = debouncedName
    return out
  }, [setCode, year, verdict, unpriced, debouncedName])

  const selection = useSelection<SealedRow>(
    data?.rows ?? [],
    data?.totalRows ?? 0,
    filters,
  )
  const { clear } = selection

  useEffect(() => {
    setPage(1)
    clear()
  }, [filters, clear])

  useEffect(() => {
    api.bulkActions('sealed').then(setActions).catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, charts] = await Promise.all([
        api.sealed(filters, {
          page,
          perPage: PER_PAGE,
          sort: String(sort.columnAccessor),
          dir: sort.direction,
        }),
        api.sealedInsights(filters),
      ])
      setData(rows)
      setInsights(charts)
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Could not load',
        color: 'red',
      })
    } finally {
      setLoading(false)
    }
  }, [filters, page, sort])

  useEffect(() => {
    void load()
  }, [load, revision])

  const empty = data && data.grandTotals.rows === 0

  return (
    <>
      {firstLoad ? (
        <HeroSkeleton />
      ) : (
        <div style={{ marginBottom: 'var(--mantine-spacing-md)' }}>
          <Text c="dimmed" fz="xs" tt="uppercase" fw={600}>
            {data && data.totals.rows !== data.grandTotals.rows
              ? 'Filtered value'
              : 'Sealed value'}
          </Text>
          <Text fz={40} fw={650} lh={1.1}>
            {data?.totals.value ?? '—'}
          </Text>
          <Text c="dimmed" fz="sm">
            {data
              ? `${data.totals.quantity} decks across ${data.totals.rows} rows` +
                (data.totals.unpriced
                  ? ` · ${data.totals.unpriced} unpriced, so this is a floor`
                  : '')
              : ''}
          </Text>
        </div>
      )}

      {empty && (
        <Alert mb="md" title="No sealed product yet">
          <Text fz="sm" mb="sm">
            Start from the template below, add a row per deck, then bring it
            back through the <Anchor href="/imports">Import</Anchor> screen. Name
            and Quantity are enough — everything else can wait until you price
            them.
          </Text>
          <TemplateButton />
        </Alert>
      )}

      {data && data.totals.unresolved > 0 && (
        <Alert color="orange" mb="md" title="Some rows didn't resolve">
          {data.totals.unresolved} row(s) matched no known commander deck, so they
          carry no set, year or lookup link. Fix the names and re-import, or
          leave them — they still count toward quantity.
        </Alert>
      )}

      {firstLoad && <ChartsSkeleton />}
      {insights && !empty && !firstLoad && (
        <Refetching active={refetching}>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="md">
            <Card withBorder padding="md" radius="md">
              <Title order={4} fz="sm">
                Value by release year
              </Title>
              <Text c="dimmed" fz="xs" mb="sm">
                Chronological, not sorted by value — older precons climb, recent
                ones sit near release price.
              </Text>
              <BarChart
                h={200}
                data={insights.byYear.map((y) => ({
                  year: y.year,
                  Value: y.cents / 100,
                }))}
                dataKey="year"
                series={[{ name: 'Value', color: 'blue.6' }]}
                gridAxis="y"
                valueFormatter={(v) => `$${v.toLocaleString()}`}
              />
            </Card>

            <Card withBorder padding="md" radius="md">
              <Title order={4} fz="sm">
                How much is actually priced
              </Title>
              <Text c="dimmed" fz="xs" mb="sm">
                Prices are entered by hand, so a partial valuation is normal —
                the total above covers only the priced decks.
              </Text>
              <Coverage insights={insights} />
            </Card>
          </SimpleGrid>
        </Refetching>
      )}

      <Paper withBorder p="xs" mb="md">
        <Group gap="xs">
          <Select
            size="xs"
            label="Set"
            w={110}
            clearable
            searchable
            data={data?.facets.sets ?? []}
            value={setCode}
            onChange={setSetCode}
          />
          <Select
            size="xs"
            label="Year"
            w={100}
            clearable
            data={data?.facets.years ?? []}
            value={year}
            onChange={setYear}
          />
          <Select
            size="xs"
            label="Verdict"
            w={130}
            clearable
            data={['undecided', 'sell', 'keep']}
            value={verdict}
            onChange={setVerdict}
          />
          <TextInput
            size="xs"
            label="Name"
            placeholder="search"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Checkbox
            label="Needs a price"
            size="xs"
            mt="lg"
            checked={unpriced}
            onChange={(e) => setUnpriced(e.currentTarget.checked)}
          />
          {/* Adding to the shelf is a recurring job, not a one-off, so the
              template stays reachable after the first import rather than
              disappearing with the empty state. */}
          <TemplateButton ml="auto" mt="lg" />
        </Group>
      </Paper>

      <BulkBar
        selection={selection}
        actions={actions}
        totalMatching={data?.totalRows ?? 0}
        pageSize={data?.rows.length ?? 0}
        filters={filters}
        onDone={() => {
          selection.clear()
          onChange()
          void load()
        }}
      />

      <DataTable<SealedRow>
        withTableBorder
        borderRadius="md"
        minHeight={200}
        fetching={loading}
        records={data?.rows ?? []}
        idAccessor="id"
        selectedRecords={selection.picked}
        onSelectedRecordsChange={selection.setPicked}
        sortStatus={sort}
        onSortStatusChange={setSort}
        totalRecords={data?.totalRows ?? 0}
        recordsPerPage={PER_PAGE}
        page={page}
        onPageChange={setPage}
        noRecordsText="No sealed product matches these filters."
        columns={[
          {
            accessor: 'name',
            title: 'Deck',
            sortable: true,
            render: (row) => (
              <div>
                <Text fz="sm" fw={550}>
                  {row.name}
                </Text>
                <Text fz="xs" c="dimmed">
                  {row.resolved ? row.setName : 'unmatched'}
                  {row.condition !== 'sealed' ? ` · ${row.condition}` : ''}
                </Text>
              </div>
            ),
          },
          { accessor: 'setCode', title: 'Set', sortable: true, width: 80 },
          { accessor: 'year', sortable: true, width: 70 },
          {
            accessor: 'quantity',
            title: 'Qty',
            sortable: true,
            textAlign: 'right',
            width: 70,
            render: (row) => `×${row.quantity}`,
          },
          {
            accessor: 'price',
            title: 'Each',
            sortable: true,
            textAlign: 'right',
            width: 96,
          },
          {
            accessor: 'total',
            title: 'Total',
            sortable: true,
            textAlign: 'right',
            width: 104,
          },
          {
            accessor: 'gain',
            title: 'Gain',
            textAlign: 'right',
            width: 96,
            // Blank without a cost basis — never zero.
            render: (row) => (row.gainCents === null ? '—' : row.gain),
          },
          {
            accessor: 'purchaseUrl',
            title: 'Price',
            width: 92,
            render: (row) =>
              row.purchaseUrl ? (
                <Anchor
                  href={row.purchaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  fz="xs"
                  title="Open this product on TCGplayer"
                >
                  look up ↗
                </Anchor>
              ) : (
                <Text c="dimmed" fz="xs">
                  —
                </Text>
              ),
          },
          {
            accessor: 'verdict',
            width: 104,
            render: (row) =>
              row.verdict === 'undecided' ? null : (
                <Badge
                  size="sm"
                  variant={row.verdict === 'sell' ? 'filled' : 'light'}
                  color={row.verdict === 'sell' ? 'blue' : 'gray'}
                >
                  {row.verdict}
                </Badge>
              ),
          },
        ]}
      />
    </>
  )
}

/**
 * A starter `sealed.csv`, straight from the server.
 *
 * A plain anchor rather than a fetch: the browser already knows how to save a
 * file the server marks as an attachment, and this way it works with no
 * JavaScript state to get wrong. The bytes are `binders.sealed.template_csv`,
 * the same ones `binders sealed template` writes — a starter file that
 * disagreed with the parser would walk you into the import error it exists to
 * help you avoid.
 */
function TemplateButton(props: { ml?: string; mt?: string }) {
  return (
    <Button
      size="xs"
      variant="default"
      {...downloadProps('sealed-template', '/api/sealed/template')}
      {...props}
    >
      Download template
    </Button>
  )
}

function Coverage({ insights }: { insights: SealedInsights }) {
  const { priced, unpriced } = insights.coverage
  const total = priced + unpriced
  const pct = total ? Math.round((priced / total) * 100) : 0
  return (
    <>
      <Group justify="space-between" mb={6}>
        <Text fz="xs" c="dimmed">
          {priced} priced
        </Text>
        <Text fz="xs" c="dimmed">
          {unpriced} need a price
        </Text>
      </Group>
      <Progress.Root size="xl">
        <Progress.Section value={pct} color="blue">
          <Progress.Label>{pct}%</Progress.Label>
        </Progress.Section>
      </Progress.Root>
      <Text fz="xs" c="dimmed" mt="xs">
        {pct === 100
          ? 'Every deck in scope has a price.'
          : `${pct}% priced — filter to "Needs a price" and use the look-up links.`}
      </Text>
    </>
  )
}

function BulkBar({
  selection,
  actions,
  totalMatching,
  pageSize,
  filters,
  onDone,
}: {
  selection: ReturnType<typeof useSelection<SealedRow>>
  actions: BulkAction[]
  totalMatching: number
  pageSize: number
  filters: Filters
  onDone: () => void
}) {
  const [action, setAction] = useState<string | null>('verdict')
  const [value, setValue] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof api.bulkPreview>
  > | null>(null)
  const [busy, setBusy] = useState(false)

  if (selection.count === 0) return null
  const spec = actions.find((a) => a.key === action)

  // `kind: 'sealed'` rides along so the server resolves the selection against
  // the sealed table — never a materialized id list for "everything matching".
  const request = () => ({ ...selection.toRequest(), kind: 'sealed' as const, filters })

  const openConfirm = async () => {
    try {
      setPreview(await api.bulkPreview(request()))
      setConfirming(true)
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Could not preview',
        color: 'red',
      })
    }
  }

  const apply = async () => {
    setBusy(true)
    try {
      const result = await api.bulkApply(request(), action!, value)
      notifications.show({
        message: `${result.summary} on ${result.affected} row(s). Undo is available.`,
        color: 'blue',
      })
      setConfirming(false)
      setValue('')
      onDone()
    } catch (error) {
      notifications.show({
        message: error instanceof ApiError ? error.message : 'Bulk edit failed',
        color: 'red',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Paper withBorder p="xs" mb="md" bg="var(--mantine-color-blue-light)">
        <Group gap="xs">
          <Text fw={600} fz="sm">
            {selection.count} selected
          </Text>
          {selection.canEscalate && (
            <Anchor fz="xs" onClick={selection.escalate}>
              select all {totalMatching} matching this filter
            </Anchor>
          )}
          {selection.allMatching && (
            <Text fz="xs" c="dimmed">
              All {totalMatching} matching rows selected ·{' '}
              <Anchor fz="xs" onClick={selection.collapseToPage}>
                just this page ({pageSize})
              </Anchor>
            </Text>
          )}
          <Group gap="xs" ml="auto">
            <Select
              size="xs"
              w={170}
              data={actions.map((a) => ({ value: a.key, label: a.label }))}
              value={action}
              onChange={setAction}
            />
            {spec?.needsValue && (
              <TextInput
                size="xs"
                w={130}
                aria-label="Bulk action value"
                placeholder={action === 'adjust_price' ? 'e.g. -10' : 'value'}
                value={value}
                onChange={(e) => setValue(e.currentTarget.value)}
              />
            )}
            <Button size="xs" onClick={openConfirm} disabled={!action}>
              Apply
            </Button>
            <Button size="xs" variant="subtle" onClick={selection.clear}>
              Clear
            </Button>
          </Group>
        </Group>
      </Paper>

      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={`${spec?.label ?? 'Apply'} on ${preview?.count ?? 0} row(s)?`}
      >
        {preview && (
          <>
            <Text fz="sm" mb="xs">
              {preview.quantity} decks · {preview.value}
            </Text>
            <Paper withBorder p="xs" mb="md">
              {preview.sample.map((row, i) => (
                <Text key={i} fz="xs" c="dimmed">
                  {row.title} · {row.edition} · ×{row.quantity} · {row.price}
                </Text>
              ))}
              {preview.more > 0 && (
                <Text fz="xs" c="dimmed">
                  …and {preview.more} more
                </Text>
              )}
            </Paper>
            {spec?.destructive && (
              <Alert color="orange" mb="md" title="This deletes rows">
                Reversible only with Undo.
              </Alert>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                color={spec?.destructive ? 'red' : undefined}
                loading={busy}
                onClick={apply}
              >
                {spec?.label}
              </Button>
            </Group>
          </>
        )}
      </Modal>
    </>
  )
}
