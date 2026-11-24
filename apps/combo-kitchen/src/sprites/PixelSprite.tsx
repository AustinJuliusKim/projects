import type { ReactElement } from "react";
import { PALETTE, SPRITES } from "./data.ts";

interface Props {
  name: string;
  className?: string;
  /** Center the artwork's bounding box within the 16x16 viewport. Use in
   * card/grid contexts (tiles, cookbook, reveal); leave off for scene
   * sprites whose in-grid position is part of the layout. */
  center?: boolean;
}

// Whole-pixel viewBox offset that centers a sprite's non-transparent
// bounding box, cached per sprite name.
const centerOffsets = new Map<string, { x: number; y: number }>();

function centerOffset(name: string, rows: readonly string[]): { x: number; y: number } {
  const cached = centerOffsets.get(name);
  if (cached) return cached;
  let minX = 16, maxX = -1, minY = 16, maxY = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === ".") continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  });
  const offset =
    maxX < 0
      ? { x: 0, y: 0 }
      : { x: Math.round((minX + maxX + 1) / 2 - 8), y: Math.round((minY + maxY + 1) / 2 - 8) };
  centerOffsets.set(name, offset);
  return offset;
}

export function PixelSprite({ name, className, center }: Props) {
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
  const offset = center ? centerOffset(name, rows) : { x: 0, y: 0 };
  return (
    <svg
      viewBox={`${offset.x} ${offset.y} 16 16`}
      shapeRendering="crispEdges"
      className={className ? `sprite ${className}` : "sprite"}
      aria-hidden="true"
      focusable="false"
    >
      {rects}
    </svg>
  );
}
