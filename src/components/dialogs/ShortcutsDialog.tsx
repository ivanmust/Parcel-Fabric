import { SHORTCUTS } from "../../app/shortcuts";
import { useApp } from "../../stores/appStore";

export function ShortcutsDialog() {
  const open = useApp((s) => s.dialogs.shortcuts);
  const setDialog = useApp((s) => s.setDialog);
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];

  return (
    <calcite-dialog open={open || undefined} modal heading="Keyboard shortcuts & help" width="m" oncalciteDialogClose={() => setDialog("shortcuts", false)}>
      {groups.map((g) => (
        <section key={g} style={{ marginBottom: 16 }}>
          <h3 className="ps-section-title" style={{ marginBottom: 8 }}>
            {g}
          </h3>
          <div className="ps-shortcuts">
            {SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <FragmentRow key={s.id} label={s.label} keys={s.keys} />
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3 className="ps-section-title" style={{ marginBottom: 8 }}>
          Tips
        </h3>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
          <li>Right-click the map for identify, coordinates and navigation actions.</li>
          <li>Drag panel edges to resize them; sizes are remembered.</li>
          <li>Layer list items have a transparency slider and legend in their item panel.</li>
          <li>The GIS Services panel shows what the connected ArcGIS services actually support.</li>
        </ul>
      </section>
    </calcite-dialog>
  );
}

function FragmentRow({ label, keys }: { label: string; keys: string }) {
  return (
    <>
      <span>{label}</span>
      <span>
        {(keys === "+" ? ["+"] : keys.split("+")).map((k, i) => (
          <span key={i}>
            {i > 0 && " + "}
            <kbd className="ps-kbd">{k}</kbd>
          </span>
        ))}
      </span>
    </>
  );
}
