import React from "react";

// Shared navigation primitive: an anchor styled identically to <Button>
// (.btn sets text-decoration:none / text-align:center, so it looks like a
// button). Use for hash routes (href="#/…"); use <Button> for JS actions.
const VARIANT = {
  default: "btn",
  primary: "btn primary",
  ghost: "btn ghost",
  danger: "btn danger",
  link: "link-btn",
};

export default function NavButton({
  variant = "default",
  className = "",
  children,
  ...rest
}) {
  const base = VARIANT[variant] || VARIANT.default;
  return (
    <a className={`${base}${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </a>
  );
}
