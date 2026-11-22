import { useRef, useState } from "react";

interface Props {
  /** CSS custom property on :root that holds the size, e.g. "--ps-left-w" */
  cssVar: string;
  axis: "x" | "y";
  min: number;
  max: number;
  /** +1 when dragging right/down grows the panel, −1 when it shrinks it */
  direction: 1 | -1;
  label: string;
}

const STORE_KEY = "parcel-studio.sizes";

function saved(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

// Restore persisted sizes once at module load.
for (const [k, v] of Object.entries(saved())) document.documentElement.style.setProperty(k, `${v}px`);

/** Drag handle (pointer + keyboard) that resizes a panel through a CSS variable. */
export function Resizer({ cssVar, axis, min, max, direction, label }: Props) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pos: 0, size: 0 });

  const current = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || min;
  const apply = (size: number) => {
    const clamped = Math.round(Math.min(max, Math.max(min, size)));
    document.documentElement.style.setProperty(cssVar, `${clamped}px`);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...saved(), [cssVar]: clamped }));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("resize"));
  };

  return (
    <div
      className={`ps-resizer ${axis === "x" ? "vertical" : "horizontal"} ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: axis === "x" ? e.clientX : e.clientY, size: current() };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const delta = (axis === "x" ? e.clientX : e.clientY) - start.current.pos;
        apply(start.current.size + delta * direction);
      }}
      onPointerUp={() => setDragging(false)}
      onKeyDown={(e) => {
        const grow = axis === "x" ? (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0) : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (grow) {
          e.preventDefault();
          apply(current() + grow * direction * 16);
        }
      }}
    />
  );
}
