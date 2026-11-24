import { useCallback, useRef, useState } from "react";
import type { Dish, IngredientId } from "./game/types.ts";
import { cook } from "./game/logic.ts";
import { useCookbook } from "./hooks/useCookbook.ts";
import { Pantry } from "./components/Pantry.tsx";
import { KitchenScene } from "./components/KitchenScene.tsx";
import { PixelSprite } from "./sprites/PixelSprite.tsx";
import { CookingScene } from "./components/CookingScene.tsx";
import { DishReveal } from "./components/DishReveal.tsx";
import { Cookbook } from "./components/Cookbook.tsx";

type Phase = "pantry" | "cooking" | "reveal";

interface CookResult {
  dish: Dish;
  isMystery: boolean;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("pantry");
  const [selected, setSelected] = useState<IngredientId[]>([]);
  const [showCookbook, setShowCookbook] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const resultRef = useRef<CookResult | null>(null);
  const { discovered, record } = useCookbook();

  const toggle = (id: IngredientId) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : prev.length < 3 ? [...prev, id] : prev,
    );
  };

  const startCooking = () => {
    if (selected.length !== 3) return;
    resultRef.current = cook(selected);
    setPhase("cooking");
  };

  const finishCooking = useCallback(() => {
    const result = resultRef.current;
    if (result) {
      setIsNew(result.isMystery ? false : record(result.dish));
    }
    setPhase("reveal");
  }, [record]);

  const cookAgain = () => {
    resultRef.current = null;
    setSelected([]);
    setPhase("pantry");
  };

  return (
    <div className="app crt">
      <header className="app-header">
        <h1>Combo Kitchen</h1>
        {phase !== "cooking" && (
          <button type="button" className="btn btn-cookbook" onClick={() => setShowCookbook(true)}>
            <PixelSprite name="book" className="btn-sprite" />
            Cookbook
          </button>
        )}
      </header>
      <main>
        <KitchenScene>
          {phase === "pantry" && (
            <Pantry selected={selected} onToggle={toggle} onCook={startCooking} />
          )}
          {phase === "cooking" && <CookingScene selected={selected} onDone={finishCooking} />}
          {phase === "reveal" && resultRef.current && (
            <DishReveal
              dish={resultRef.current.dish}
              isNew={isNew}
              isMystery={resultRef.current.isMystery}
              onCookAgain={cookAgain}
            />
          )}
        </KitchenScene>
      </main>
      {showCookbook && <Cookbook discovered={discovered} onClose={() => setShowCookbook(false)} />}
    </div>
  );
}
