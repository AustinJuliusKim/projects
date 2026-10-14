import { Link } from "react-router-dom";
import { Anchor, Container, Stack, Text, Title } from "@mantine/core";

import { useSeo } from "../useSeo.js";

// Stores live at /s/{slug}; there is no store directory yet.
export default function LandingPage() {
  useSeo({ title: "Card shop", description: "Shop in-stock singles and reserve them for pickup." });
  return (
    <Container size="sm" py="xl">
      <Stack>
        <Title order={2}>Card shop storefronts</Title>
        <Text>
          Each store has its own address, like{" "}
          <Anchor component={Link} to="/s/demo">
            /s/demo
          </Anchor>
          .
        </Text>
      </Stack>
    </Container>
  );
}
