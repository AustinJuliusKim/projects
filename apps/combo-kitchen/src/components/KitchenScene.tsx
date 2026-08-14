import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
}

// Fixed backdrop that puts every phase "in the kitchen": tiled backsplash,
// window with curtains, a shelf of jars, and a wooden counter along the
// bottom. Pure decoration — all layers are aria-hidden and sit behind the
// stage content.
export function KitchenScene({ children }: Props) {
  return (
    <>
      <div className="kitchen-backdrop" aria-hidden="true">
        <div className="scene-backsplash" />
        <div className="scene-window">
          <span className="scene-cloud">☁️</span>
          <div className="scene-curtain scene-curtain-l" />
          <div className="scene-curtain scene-curtain-r" />
        </div>
        <div className="scene-shelf">
          <span>🫙</span>
          <span>🍯</span>
          <span>🧂</span>
        </div>
        <div className="scene-counter" />
      </div>
      <div className="stage">{children}</div>
    </>
  );
}
