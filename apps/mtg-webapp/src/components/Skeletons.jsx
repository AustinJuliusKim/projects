import { Card, Grid, Group, Paper, Skeleton, SimpleGrid, Stack } from "@mantine/core";

export function CardGridSkeleton({ count = 10 }) {
  return (
    <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5 }} spacing="md" mt="md" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} withBorder padding="sm" radius="md">
          <Skeleton style={{ aspectRatio: "488 / 680" }} w="100%" />
          <Skeleton height={14} width="70%" mt="xs" />
        </Card>
      ))}
    </SimpleGrid>
  );
}

export function SimilarRowsSkeleton({ count = 4 }) {
  return (
    <Stack gap="xs" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <Paper key={i} withBorder p="xs" radius="sm">
          <Group wrap="nowrap" gap="xs">
            <Skeleton height={14} style={{ flex: 1 }} />
            <Skeleton height={18} width={64} radius="xl" />
          </Group>
          <Skeleton height={10} width="60%" mt={4} />
        </Paper>
      ))}
    </Stack>
  );
}

export function CardPageSkeleton() {
  return (
    <Grid gutter="xl" aria-busy="true">
      <Grid.Col span={{ base: 12, sm: 4, md: 3 }}>
        <Stack>
          <Skeleton style={{ aspectRatio: "488 / 680" }} w="100%" radius="md" />
          <Skeleton height={36} />
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 8, md: 9 }}>
        <Stack gap="lg">
          <Stack gap={6}>
            <Skeleton height={32} width="55%" />
            <Skeleton height={16} width="35%" />
            <Skeleton height={14} width="90%" />
            <Skeleton height={14} width="85%" />
            <Skeleton height={14} width="60%" />
          </Stack>
          <div>
            <Skeleton height={20} width={120} mb="xs" />
            <SimilarRowsSkeleton />
          </div>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
