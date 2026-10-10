import { Container, Text, Title } from "@mantine/core";

import { useSeo } from "../useSeo.js";

export default function NotFoundPage() {
  useSeo({ title: "Page not found", noindex: true });
  return (
    <Container size="sm" py="xl">
      <Title order={2}>Page not found</Title>
      <Text c="dimmed">There’s nothing at this address.</Text>
    </Container>
  );
}
