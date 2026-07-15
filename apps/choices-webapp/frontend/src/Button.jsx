import React from "react";

// Shared button primitive for ACTIONS (onClick / type=submit). Variants map to
// the .btn.* / .link-btn classes in styles.css, so <Button> and <NavButton>
// render identically — the difference is only <button> vs <a> semantics.
// `busy` disables the control; callers still swap the label themselves.
const VARIANT = {
  default: "btn",
  primary: "btn primary",
  ghost: "btn ghost",
  danger: "btn danger",
  link: "link-btn",
};

export default function Button({
  variant = "default",
  busy = false,
  disabled = false,
  className = "",
  children,
  ...rest
}) {
  const base = VARIANT[variant] || VARIANT.default;
  return (
    <button
      className={`${base}${className ? ` ${className}` : ""}`}
      disabled={disabled || busy}
      {...rest}
    >
      {children}
    </button>
  );
}
