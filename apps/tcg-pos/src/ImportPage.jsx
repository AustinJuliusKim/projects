import { useState } from "react";
import { Alert, Badge, Button, FileInput, Group, Stack, Table, Text } from "@mantine/core";

import { importTcgplayer } from "./api.js";
import { canApply, checkFile, sortRows, statusColor, summarize } from "./importView.js";
import { displayCents } from "./money.js";
import { isUuid } from "./receive.js";

// TCGplayer inventory CSV: preview (dry run) first, then apply. Applying
// *sets* each listed item to the CSV quantity, so re-applying is harmless.
export default function ImportPage({ tenantId, locationId }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // { dryRun, fileKey, result }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fileKey = file ? `${file.name}|${file.size}|${file.lastModified}` : null;

  async function run(dryRun) {
    setError(null);
    if (!isUuid(tenantId)) return setError("No store selected.");
    if (!isUuid(locationId)) return setError("Enter a location ID (UUID).");
    const fileError = checkFile(file);
    if (fileError) return setError(fileError);
    setBusy(true);
    try {
      const text = await file.text();
      const result = await importTcgplayer(text, { locationId, dryRun });
      setPreview({ dryRun, fileKey, result });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const result = preview && preview.fileKey === fileKey ? preview.result : null;

  return (
    <Stack>
      <Group align="flex-end">
        <FileInput
          label="TCGplayer inventory export (.csv)"
          placeholder="Choose file"
          accept=".csv,text/csv"
          value={file}
          onChange={(f) => {
            setFile(f);
            setPreview(null);
          }}
          w={340}
        />
        <Button onClick={() => run(true)} loading={busy} variant="default">
          Preview
        </Button>
        <Button
          onClick={() => run(false)}
          loading={busy}
          disabled={!canApply(preview, fileKey)}
          color="red"
        >
          Apply
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Only Magic rows are imported. Each matched item is set to the file&apos;s Total
        Quantity (and TCG Marketplace Price, when present) at this location.
      </Text>

      {error && <Alert color="red">{error}</Alert>}
      {result && (
        <Alert color={result.dry_run ? "blue" : "green"}>
          {result.dry_run ? "Preview: " : "Applied: "}
          {summarize(result)}
        </Alert>
      )}

      {result && (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Line</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Card</Table.Th>
              <Table.Th>Set</Table.Th>
              <Table.Th>Cond.</Table.Th>
              <Table.Th>Finish</Table.Th>
              <Table.Th ta="right">Qty</Table.Th>
              <Table.Th ta="right">Price</Table.Th>
              <Table.Th>Note</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sortRows(result.rows).map((r) => (
              <Table.Tr key={r.row}>
                <Table.Td>{r.row}</Table.Td>
                <Table.Td>
                  <Badge color={statusColor(r.status)} variant="light">
                    {r.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{r.product_name}</Table.Td>
                <Table.Td>
                  {r.set_code ? `${r.set_code.toUpperCase()} #${r.number}` : r.set_name}
                </Table.Td>
                <Table.Td>{r.condition}</Table.Td>
                <Table.Td>{r.finish}</Table.Td>
                <Table.Td ta="right">{r.qty ?? "—"}</Table.Td>
                <Table.Td ta="right">{displayCents(r.price_cents)}</Table.Td>
                <Table.Td>{r.reason}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
