import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  Alert,
  Anchor,
  Button,
  Grid,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";

import { ApiError, createOrder } from "../api.js";
import {
  cartSubtotal,
  ensureAttempt,
  issuesById,
  issueText,
  loadAttempt,
  orderBody,
  saveAttempt,
  validateCustomer,
} from "../cart.js";
import LineInfo from "../components/LineInfo.jsx";
import { displayCents } from "../money.js";
import { pageTitle } from "../seo.js";
import { useStore } from "../storeContext.js";
import { useSeo } from "../useSeo.js";

export default function CheckoutPage() {
  const { slug, base, store, cart, dispatch } = useStore();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState({ name: "", email: "", phone: "" });
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [issues, setIssues] = useState({});
  useSeo({ title: pageTitle(["Checkout"], store.display_name), noindex: true });

  const errors = useMemo(() => validateCustomer(customer), [customer]);
  const subtotal = cartSubtotal(cart);
  const issueList = Object.values(issues).filter((r) =>
    cart.lines.some((l) => l.inventory_item_id === r.inventory_item_id),
  );

  if (!cart.lines.length && !submitting) return <Navigate to={`${base}/cart`} replace />;

  const field = (name) => ({
    value: customer[name],
    onChange: (e) => setCustomer({ ...customer, [name]: e.currentTarget.value }),
    error: touched ? errors[name] : undefined,
  });

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length || submitting) return;
    // One idempotency key per attempt: a retry of the same cart (network
    // error, double click, reload) reuses it, so the server can't create a
    // second order; a changed cart gets a new one.
    const attempt = ensureAttempt(loadAttempt(slug), cart);
    saveAttempt(slug, attempt);
    setSubmitting(true);
    setError(null);
    try {
      const order = await createOrder(slug, orderBody(cart, customer, attempt.key));
      saveAttempt(slug, null);
      dispatch({ type: "clear" });
      const code = encodeURIComponent(order.pickup_code);
      navigate(`${base}/order/${order.id}?code=${code}`, { replace: true });
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.status === 409) {
        if (err.issues.length) {
          setIssues(issuesById(err.issues));
          setError("Some items can’t be reserved as they are. Review them below.");
        } else {
          // The key was already used for a different cart: start a new attempt.
          saveAttempt(slug, null);
          setError("Your cart changed during checkout. Please place the order again.");
        }
      } else {
        setError(err.message || "Something went wrong. Please try again.");
      }
    }
  }

  return (
    <Grid gutter="xl">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <form onSubmit={submit} noValidate>
          <Stack gap="md">
            <Title order={2}>Reserve for pickup</Title>
            <Text c="dimmed" size="sm">
              We’ll hold these cards for {store.reservation_hours} hours at{" "}
              {store.pickup_location.name}. Nothing is charged online — pay when you pick up.
            </Text>
            {store.pickup_text && <Text size="sm">{store.pickup_text}</Text>}
            <TextInput label="Name" autoComplete="name" required maxLength={100} {...field("name")} />
            <TextInput
              label="Email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              {...field("email")}
            />
            <TextInput
              label="Phone (optional)"
              type="tel"
              autoComplete="tel"
              maxLength={40}
              {...field("phone")}
            />
            {error && <Alert color="red">{error}</Alert>}
            <Group>
              <Button type="submit" loading={submitting} size="md">
                Reserve {cart.lines.length} item{cart.lines.length === 1 ? "" : "s"}
              </Button>
              <Anchor component={Link} to={`${base}/cart`} size="sm">
                Back to cart
              </Anchor>
            </Group>
            {store.policy_text && (
              <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-line" }}>
                {store.policy_text}
              </Text>
            )}
          </Stack>
        </form>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Paper withBorder p="md" radius="md">
          <Stack gap="sm">
            <Title order={3} size="h5">
              Order summary
            </Title>
            {cart.lines.map((line) => {
              const issue = issues[line.inventory_item_id];
              return (
                <Stack key={line.inventory_item_id} gap={2}>
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <LineInfo line={line} base={base} />
                    <Text size="sm" style={{ whiteSpace: "nowrap" }}>
                      {line.qty} × {displayCents(line.unit_price_cents)}
                    </Text>
                  </Group>
                  {issue && (
                    <Text size="xs" c="red">
                      {issueText(issue)}
                      {issue.status === "price_changed"
                        ? ` — now ${displayCents(issue.unit_price_cents)}`
                        : ""}
                    </Text>
                  )}
                </Stack>
              );
            })}
            <Group justify="space-between" pt="xs">
              <Text fw={600}>Total</Text>
              <Text fw={700}>{displayCents(subtotal)}</Text>
            </Group>
            {issueList.length > 0 && (
              <Button
                variant="light"
                onClick={() => {
                  dispatch({ type: "applyQuote", quote: { lines: issueList } });
                  setIssues({});
                  setError(null);
                }}
              >
                Update cart to what’s available
              </Button>
            )}
          </Stack>
        </Paper>
      </Grid.Col>
    </Grid>
  );
}
