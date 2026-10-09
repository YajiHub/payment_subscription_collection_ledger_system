import type { ReactNode } from "react";
import { Minus, Plus, RotateCcw, ZoomIn } from "lucide-react";
import { useDisplayScaleStore, AVAILABLE_SCALES, type DisplayScale } from "../../stores/display-scale.store";

export function DisplayScaleControl(): ReactNode {
  const { scale, setScale, zoomIn, zoomOut, resetZoom } = useDisplayScaleStore();

  const isMin = scale <= AVAILABLE_SCALES[0]!;
  const isMax = scale >= AVAILABLE_SCALES[AVAILABLE_SCALES.length - 1]!;

  return (
    <div
      className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface/90 px-2 py-1 shadow-2xs backdrop-blur-xs transition-all hover:border-line-strong"
      title="Display Zoom (Ctrl + / Ctrl -)"
    >
      <button
        type="button"
        onClick={zoomOut}
        disabled={isMin}
        aria-label="Zoom out"
        className="flex h-6 w-6 items-center justify-center rounded-lg text-content-secondary hover:bg-canvas hover:text-content-primary disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>

      <div className="flex items-center gap-1 px-1.5">
        <ZoomIn className="h-3.5 w-3.5 text-accent" />
        <select
          value={scale}
          onChange={(e) => setScale(Number.parseInt(e.target.value, 10) as DisplayScale)}
          aria-label="Display Scale"
          className="cursor-pointer appearance-none bg-transparent text-xs font-semibold text-content-primary focus:outline-none"
        >
          {AVAILABLE_SCALES.map((s) => (
            <option key={s} value={s}>
              {s}%
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        onClick={zoomIn}
        disabled={isMax}
        aria-label="Zoom in"
        className="flex h-6 w-6 items-center justify-center rounded-lg text-content-secondary hover:bg-canvas hover:text-content-primary disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {scale !== 100 && (
        <button
          type="button"
          onClick={resetZoom}
          aria-label="Reset zoom"
          title="Reset to 100%"
          className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-lg text-content-secondary hover:bg-canvas hover:text-content-primary transition-colors"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
