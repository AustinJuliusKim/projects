import { useEffect, useRef } from "react";
import { Box, Button, Group, SimpleGrid, Stack } from "@mantine/core";

import { PIN_LENGTH, pinKey } from "./register.js";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];
const LABEL = { clear: "Clear", back: "⌫" };

// A touch-sized PIN pad (also takes the keyboard's digits, Backspace and
// Enter, except while typing in another field).
export default function PinPad({ value, onChange, onSubmit, disabled = false, submitLabel = "Sign in", busy = false }) {
  const latest = useRef({ value, onChange, onSubmit, disabled });
  latest.current = { value, onChange, onSubmit, disabled };

  useEffect(() => {
    function onKey(e) {
      const { value: v, onChange: change, onSubmit: submit, disabled: off } = latest.current;
      const tag = e.target && e.target.tagName;
      if (off || tag === "INPUT" || tag === "TEXTAREA") return;
      if (/^[0-9]$/.test(e.key)) change(pinKey(v, e.key));
      else if (e.key === "Backspace") change(pinKey(v, "back"));
      else if (e.key === "Enter" && v.length === PIN_LENGTH) submit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Stack align="center" gap="sm">
      <Group gap={10} aria-label={`${value.length} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <Box
            key={i}
            w={16}
            h={16}
            style={{
              borderRadius: "50%",
              border: "2px solid var(--mantine-color-dimmed)",
              background: i < value.length ? "var(--mantine-color-text)" : "transparent",
            }}
          />
        ))}
      </Group>
      <SimpleGrid cols={3} spacing="xs" w={260}>
        {KEYS.map((k) => (
          <Button
            key={k}
            size="lg"
            variant={/^[0-9]$/.test(k) ? "default" : "subtle"}
            disabled={disabled}
            onClick={() => onChange(pinKey(value, k))}
          >
            {LABEL[k] || k}
          </Button>
        ))}
      </SimpleGrid>
      <Button w={260} disabled={disabled || value.length !== PIN_LENGTH} loading={busy} onClick={onSubmit}>
        {submitLabel}
      </Button>
    </Stack>
  );
}
