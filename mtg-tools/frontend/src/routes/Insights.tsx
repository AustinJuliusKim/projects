import { useState } from 'react'
import { AreaChart, BarChart } from '@mantine/charts'
import {
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Table,
  Text,
  Title,
} from '@mantine/core'
import type { Insights as InsightsData } from '../api/client'

/**
 * The charts that were only ever in the standalone `dashboard.html` generator.
 *
 * Every chart is scoped by the same filters as the table below it — a chart
 * describing a different slice than the rows underneath is worse than no chart.
 *
 * Each one has a table view. That is not decoration: a chart is the only
 * representation some readers can't use, and the numbers should never be
 * reachable exclusively through a hover tooltip.
 */
export function Insights({ data }: { data: InsightsData }) {
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="md">
      <Concentration data={data} />
      <Tiers data={data} />
      <TopSets data={data} />
      <Rarity data={data} />
    </SimpleGrid>
  )
}

function Panel({
  title,
  caption,
  chart,
  table,
}: {
  title: string
  caption: string
  chart: React.ReactNode
  table: React.ReactNode
}) {
  const [view, setView] = useState('chart')
  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" align="baseline" mb={4}>
        <Title order={4} fz="sm">
          {title}
        </Title>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={setView}
          data={[
            { label: 'Chart', value: 'chart' },
            { label: 'Table', value: 'table' },
          ]}
        />
      </Group>
      <Text c="dimmed" fz="xs" mb="sm">
        {caption}
      </Text>
      {view === 'chart' ? chart : table}
    </Card>
  )
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`

function Concentration({ data }: { data: InsightsData }) {
  const { points, marks, pricedRows } = data.concentration
  const caption = marks.length
    ? marks.map((m) => `${m.rows} rows hold ${m.valuePct}%`).join(' · ')
    : 'Cumulative share of value, most valuable row first.'

  return (
    <Panel
      title="Where the value sits"
      caption={pricedRows < 2 ? 'Needs at least two priced rows.' : caption}
      chart={
        <AreaChart
          h={200}
          data={points}
          dataKey="rowPct"
          series={[{ name: 'valuePct', label: 'Share of value', color: 'blue.6' }]}
          curveType="monotone"
          withDots={false}
          gridAxis="y"
          yAxisProps={{ domain: [0, 100], tickFormatter: (v: number) => `${v}%` }}
          xAxisProps={{ tickFormatter: (v: number) => `${Math.round(v)}%` }}
          valueFormatter={(value) => `${value}% of value`}
        />
      }
      table={
        <SmallTable
          head={['Share of value', 'Rows']}
          rows={marks.map((m) => [`${m.valuePct}%`, String(m.rows)])}
        />
      }
    />
  )
}

function Tiers({ data }: { data: InsightsData }) {
  return (
    <Panel
      title="What a buylist pays"
      caption="Market value against estimated cash and store credit, per band."
      chart={
        <BarChart
          h={200}
          data={data.tiers.map((t) => ({
            band: t.label,
            Market: t.marketCents / 100,
            Cash: t.cashCents / 100,
            Credit: t.creditCents / 100,
          }))}
          dataKey="band"
          series={[
            { name: 'Market', color: 'blue.6' },
            { name: 'Cash', color: 'orange.6' },
            { name: 'Credit', color: 'teal.6' },
          ]}
          gridAxis="y"
          withLegend
          valueFormatter={(value) => `$${value.toLocaleString()}`}
        />
      }
      table={
        <SmallTable
          head={['Band', 'Cards', 'Market', 'Cash', 'Credit']}
          rows={data.tiers.map((t) => [
            t.label,
            String(t.quantity),
            t.market,
            `${t.cash} (${t.cashPct}%)`,
            `${t.credit} (${t.creditPct}%)`,
          ])}
        />
      }
    />
  )
}

function TopSets({ data }: { data: InsightsData }) {
  return (
    <Panel
      title="Top sets by value"
      caption="The tail beyond the top twelve is grouped rather than given its own colour."
      chart={
        <BarChart
          h={240}
          data={data.sets.map((s) => ({ name: s.name, Value: s.cents / 100 }))}
          dataKey="name"
          orientation="vertical"
          series={[{ name: 'Value', color: 'blue.6' }]}
          gridAxis="x"
          yAxisProps={{ width: 130 }}
          valueFormatter={(value) => `$${value.toLocaleString()}`}
        />
      }
      table={
        <SmallTable
          head={['Set', 'Cards', 'Value']}
          rows={data.sets.map((s) => [s.name, String(s.quantity), s.value])}
        />
      }
    />
  )
}

function Rarity({ data }: { data: InsightsData }) {
  return (
    <Panel
      title="Value by rarity"
      caption="Ordered mythic to common, not by size — the ordering carries meaning."
      chart={
        <BarChart
          h={200}
          data={data.rarity.map((r) => ({ name: r.name, Value: r.cents / 100 }))}
          dataKey="name"
          series={[{ name: 'Value', color: 'blue.6' }]}
          gridAxis="y"
          valueFormatter={(value) => `$${value.toLocaleString()}`}
        />
      }
      table={
        <SmallTable
          head={['Rarity', 'Cards', 'Value']}
          rows={data.rarity.map((r) => [r.name, String(r.quantity), r.value])}
        />
      }
    />
  )
}

function SmallTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <Table fz="xs" withRowBorders={false} horizontalSpacing={6}>
      <Table.Thead>
        <Table.Tr>
          {head.map((h, i) => (
            <Table.Th key={h} ta={i === 0 ? 'left' : 'right'}>
              {h}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row[0]}>
            {row.map((cell, i) => (
              <Table.Td key={i} ta={i === 0 ? 'left' : 'right'} ff={i ? 'monospace' : undefined}>
                {cell}
              </Table.Td>
            ))}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}

export { dollars }
