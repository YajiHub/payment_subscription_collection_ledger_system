import { create } from "zustand";

export type DisplayScale = 90 | 100 | 110 | 120 | 125 | 135;

export const AVAILABLE_SCALES: readonly DisplayScale[] = [90, 100, 110, 120, 125, 135];

const STORAGE_KEY = "bcis_display_scale";

function getInitialScale(): DisplayScale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const num = Number.parseInt(saved, 10);
      if (AVAILABLE_SCALES.includes(num as DisplayScale)) {
        return num as DisplayScale;
      }
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return 100;
}

export function applyScaleToDocument(scale: DisplayScale): void {
  if (typeof document === "undefined") return;
  const factor = scale / 100;
  document.documentElement.style.setProperty("--ui-scale", String(factor));
  // In Chromium/Electron, setting zoom on documentElement scales vector elements, fonts, and layouts seamlessly
  if ("zoom" in document.documentElement.style) {
    (document.documentElement.style as unknown as { zoom: string }).zoom = String(factor);
  }
}

interface DisplayScaleState {
  scale: DisplayScale;
  setScale: (scale: DisplayScale) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export const useDisplayScaleStore = create<DisplayScaleState>((set, get) => ({
  scale: getInitialScale(),
  setScale: (scale) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(scale));
    } catch {
      // Ignore
    }
    applyScaleToDocument(scale);
    set({ scale });
  },
  zoomIn: () => {
    const current = get().scale;
    const idx = AVAILABLE_SCALES.indexOf(current);
    if (idx < AVAILABLE_SCALES.length - 1) {
      const next = AVAILABLE_SCALES[idx + 1]!;
      get().setScale(next);
    }
  },
  zoomOut: () => {
    const current = get().scale;
    const idx = AVAILABLE_SCALES.indexOf(current);
    if (idx > 0) {
      const prev = AVAILABLE_SCALES[idx - 1]!;
      get().setScale(prev);
    }
  },
  resetZoom: () => {
    get().setScale(100);
  },
}));

// Initialize document zoom immediately
if (typeof document !== "undefined") {
  applyScaleToDocument(getInitialScale());
}
