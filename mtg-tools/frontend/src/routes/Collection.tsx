import { useCallback, useEffect, useMemo, useState } from 'react'
import { DataTable, type DataTableSortStatus } from 'mantine-datatable'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  Text,
  TextInput,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useDebouncedValue } from '@mantine/hooks'

import {
  api,
  ApiError,
  type BulkAction,
  type CollectionPage,
  type Filters,
  type Holding,
  type Insights as InsightsData,
} from '../api/client'
import { useSelection } from '../components/useSelection'
import {
  ChartsSkeleton,
  HeroSkeleton,
  Refetching,
} from '../components/Skeletons'
import { Insights } from './Insights'

const PER_PAGE = 50

export function Collection({
  revision,
  onChange,
}: {
  revision: number
  onChange: () => void
}) {
  const [priceMin, setPriceMin] = useState('')
  const [edition, setEdition] = useState<string | null>(null)
  const [rarity, setRarity] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [foil, setFoil] = useState(false)
  const [unpriced, setUnpriced] = useState(false)
  const [name, setName] = useState('')
  const [debouncedName] = useDebouncedValue(name, 250)

  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<DataTableSortStatus<Holding>>({
    columnAccessor: 'total',
    direction: 'desc',
  })

  const [data, setData] = useState<CollectionPage | null>(null)
  const [insights, setInsights] = useState<InsightsData | null>(null)
  const [actions, setActions] = useState<BulkAction[]>([])
  const [loading, setLoading] = useState(true)

  // First load gets skeletons; every later fetch keeps the previous render and
  // dims it. This view refetches on each filter keystroke, sort and page
  // change — flashing grey bars that often would be worse than the wait.
  const firstLoad = loading && data === null
  const refetching = loading && data !== null

  const filters: Filters = useMemo(() => {
    const out: Filters = {}
    if (priceMin) out.price_min = priceMin
    if (edition) out.edition = edition
    if (rarity) out.rarity = rarity
    if (verdict) out.verdict = verdict
    if (foil) out.foil = '1'
    if (unpriced) out.unpriced = '1'
    if (debouncedName) out.title_contains = debouncedName
    return out
  }, [priceMin, edition, rarity, verdict, foil, unpriced, debouncedName])

  const selection = useSelection(data?.rows ?? [], data?.totalRows ?? 0, filters)
  const { clear } = selection

  useEffect(() => {
    setPage(1)
    clear()
  }, [filters, clear])

  useEffect(() => {
    api.bulkActions().then(setActions).catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, charts] = await Promise.all([
        api.collection(filters, {
          page,
          perPage: PER_PAGE,
          sort: String(sort.columnAccessor),
          dir: sort.direction,
        }),
        api.insights(filters),
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
      {firstLoad ? <HeroSkeleton /> : (
      <Group justify="space-between" align="flex-end" mb="md">
        <div>
          <Text c="dimmed" fz="xs" tt="uppercase" fw={600}>
            {data && data.totals.rows !== data.grandTotals.rows
              ? 'Filtered value'
              : 'Collection value'}
          </Text>
          <Text fz={40} fw={650} lh={1.1}>
            {data?.totals.value ?? '—'}
          </Text>
          <Text c="dimmed" fz="sm">
            {data
              ? `${data.totals.quantity} cards across ${data.totals.rows} rows` +
                (data.totals.rows !== data.grandTotals.rows
                  ? ` · of ${data.grandTotals.quantity} total`
                  : '') +
                (data.totals.unpriced
                  ? ` · ${data.totals.unpriced} unpriced, so this is a floor`
                  : '')
              : ''}
          </Text>
        </div>
      </Group>
      )}

      {empty && (
        <Alert mb="md" title="Nothing here yet">
          <Anchor href="/imports">Import a CSV</Anchor> to get started.
        </Alert>
      )}

      {firstLoad && <ChartsSkeleton />}
      {insights && !empty && !firstLoad && (
        <Refetching active={refetching}>
          <Insights data={insights} />
        </Refetching>
      )}

      <Paper withBorder p="xs" mb="md">
        <Group gap="xs">
          <TextInput
            size="xs"
            label="Price ≥"
            type="number"
            w={90}
            value={priceMin}
            onChange={(e) => setPriceMin(e.currentTarget.value)}
          />
          <Select
            size="xs"
            label="Set"
            w={130}
            clearable
            searchable
            data={data?.facets.editions ?? []}
            value={edition}
            onChange={setEdition}
          />
          <Select
            size="xs"
            label="Rarity"
            w={120}
            clearable
            data={data?.facets.rarities ?? []}
            value={rarity}
            onChange={setRarity}
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
            label="Foil"
            size="xs"
            mt="lg"
            checked={foil}
            onChange={(e) => setFoil(e.currentTarget.checked)}
          />
          <Checkbox
            label="Needs a price"
            size="xs"
            mt="lg"
            checked={unpriced}
            onChange={(e) => setUnpriced(e.currentTarget.checked)}
          />
        </Group>
      </Paper>

      <BulkBar
        selection={selection}
        actions={actions}
        totalMatching={data?.totalRows ?? 0}
        pageSize={data?.rows.length ?? 0}
        onDone={() => {
          selection.clear()
          onChange()
          void load()
        }}
      />

      <DataTable<Holding>
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
        noRecordsText="No cards match these filters."
        columns={[
          {
            accessor: 'title',
            title: 'Card',
            sortable: true,
            render: (row) => (
              <div>
                <Text fz="sm" fw={550}>
                  {row.title}
                  {row.foil && ' (foil)'}
                </Text>
                <Text fz="xs" c="dimmed">
                  {row.setName}
                  {row.collectorNumber ? ` · ${row.collectorNumber}` : ''}
                </Text>
              </div>
            ),
          },
          { accessor: 'edition', title: 'Set', sortable: true, width: 80 },
          { accessor: 'rarity', sortable: true, width: 100 },
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
            width: 100,
          },
          {
            accessor: 'total',
            title: 'Total',
            sortable: true,
            textAlign: 'right',
            width: 110,
          },
          {
            accessor: 'verdict',
            width: 110,
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

function BulkBar({
  selection,
  actions,
  totalMatching,
  pageSize,
  onDone,
}: {
  selection: ReturnType<typeof useSelection<Holding>>
  actions: BulkAction[]
  totalMatching: number
  pageSize: number
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

  const openConfirm = async () => {
    try {
      setPreview(await api.bulkPreview(selection.toRequest()))
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
      const result = await api.bulkApply(selection.toRequest(), action!, value)
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

          {/* The two selections are kept visibly distinct: at collection scale
              "this page" and "everything matching" differ by hundreds of rows. */}
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
              w={160}
              // Labelled because it had no accessible name at all: a bare
              // combobox a screen reader announces as nothing, and the control
              // that decides what a bulk edit *does*.
              aria-label="Bulk action"
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
              {preview.quantity} cards · {preview.value}
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
