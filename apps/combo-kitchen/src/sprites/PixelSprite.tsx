import type { ReactElement } from "react";
import { PALETTE, SPRITES } from "./data.ts";

interface Props {
  name: string;
  className?: string;
}

export function PixelSprite({ name, className }: Props) {
  const rows = SPRITES[name] ?? SPRITES.question;
  const rects: ReactElement[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === ".") {
        x += 1;
        continue;
      }
      // merge horizontal runs of the same color into one rect
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      rects.push(
        <rect key={`${y}-${x}`} x={x} y={y} width={end - x} height={1} fill={PALETTE[ch]} />,
      );
      x = end;
    }
  });
  return (
    <svg
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={className ? `sprite ${className}` : "sprite"}
      aria-hidden="true"
      focusable="false"
    >
      {rects}
    </svg>
  );
}
