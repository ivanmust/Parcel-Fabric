import lightCss from "@arcgis/core/assets/esri/themes/light/main.css?url";
import darkCss from "@arcgis/core/assets/esri/themes/dark/main.css?url";
import type { ThemeMode } from "../types/app";

const LINK_ID = "arcgis-core-theme";

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply Calcite mode classes and swap the ArcGIS core stylesheet. */
export function applyTheme(mode: ThemeMode): "light" | "dark" {
  const effective = resolveTheme(mode);
  const body = document.body;
  body.classList.toggle("calcite-mode-dark", effective === "dark");
  body.classList.toggle("calcite-mode-light", effective === "light");
  document.documentElement.dataset.theme = effective;

  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    document.head.prepend(link);
  }
  const href = effective === "dark" ? darkCss : lightCss;
  if (link.getAttribute("href") !== href) link.href = href;
  return effective;
}
