import { useApp } from "../../stores/appStore";
import type { CoordinateFormat, ThemeMode } from "../../types/app";

export function SettingsDialog() {
  const open = useApp((s) => s.dialogs.settings);
  const theme = useApp((s) => s.theme);
  const fmt = useApp((s) => s.coordinateFormat);
  const { setDialog, setPref } = useApp.getState();

  return (
    <calcite-dialog open={open || undefined} modal heading="Settings" width="s" oncalciteDialogClose={() => setDialog("settings", false)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <calcite-label>
          Theme
          <calcite-segmented-control
            width="full"
            oncalciteSegmentedControlChange={(e) => setPref("theme", (e.target as HTMLElement & { value: string }).value as ThemeMode)}
          >
            {(["light", "dark", "system"] as const).map((t) => (
              <calcite-segmented-control-item key={t} value={t} checked={theme === t || undefined}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </calcite-segmented-control-item>
            ))}
          </calcite-segmented-control>
        </calcite-label>
        <calcite-label>
          Geographic coordinate format (status bar)
          <calcite-segmented-control
            width="full"
            oncalciteSegmentedControlChange={(e) => setPref("coordinateFormat", (e.target as HTMLElement & { value: string }).value as CoordinateFormat)}
          >
            <calcite-segmented-control-item value="dd" checked={fmt === "dd" || undefined}>
              Decimal degrees
            </calcite-segmented-control-item>
            <calcite-segmented-control-item value="dms" checked={fmt === "dms" || undefined}>
              Degrees, minutes, seconds
            </calcite-segmented-control-item>
          </calcite-segmented-control>
        </calcite-label>
        <calcite-button
          appearance="outline"
          kind="neutral"
          icon-start="reset"
          onClick={() => {
            try {
              localStorage.removeItem("parcel-studio.sizes");
            } catch {
              /* ignore */
            }
            ["--ps-left-w", "--ps-right-w", "--ps-bottom-h"].forEach((v) => document.documentElement.style.removeProperty(v));
            window.dispatchEvent(new Event("resize"));
          }}
        >
          Reset panel sizes
        </calcite-button>
      </div>
    </calcite-dialog>
  );
}
