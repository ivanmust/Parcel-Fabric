import { useEffect, useState } from "react";
import type { IconName } from "../../types/icons";
import { useApp } from "../../stores/appStore";
import type { LeftPanelId } from "../../types/app";
import { Resizer } from "../common/Resizer";
import { ContentsPanel } from "../panels/ContentsPanel";
import { LayersPanel } from "../panels/LayersPanel";
import { UploadPanel } from "../panels/UploadPanel";
import { BookmarksPanel } from "../panels/BookmarksPanel";
import { SelectionPanel } from "../panels/SelectionPanel";
import { EditingPanel } from "../panels/EditingPanel";

/** Geoprocessing is added with Phase 6. Only working panels are listed here. */
const PANELS: { id: LeftPanelId; icon: IconName; label: string }[] = [
  { id: "contents", icon: "layers", label: "Contents" },
  { id: "layers", icon: "add-layer", label: "Layers" },
  { id: "upload", icon: "upload", label: "Upload Shapefile" },
  { id: "bookmarks", icon: "bookmark", label: "Bookmarks" },
  { id: "selection", icon: "select", label: "Selection" },
  { id: "editing", icon: "pencil", label: "Editing Tools" },
];

export function LeftSidebar({ open }: { open: boolean }) {
  const active = useApp((s) => s.leftPanel);
  const openLeftPanel = useApp((s) => s.openLeftPanel);
  // Mount a panel the first time it is shown, then keep it mounted (preserves state
  // without making every panel query services at start-up).
  const [visited, setVisited] = useState<Set<LeftPanelId>>(() => new Set([active]));
  useEffect(() => {
    if (open && !visited.has(active)) setVisited((v) => new Set(v).add(active));
  }, [open, active, visited]);

  return (
    <>
      <calcite-action-bar className="ps-actionbar" expand-disabled layout="vertical" label="Workspace panels">
        {PANELS.map((p) => (
          <calcite-action
            key={p.id}
            text={p.label}
            icon={p.icon}
            active={(open && active === p.id) || undefined}
            onClick={() => openLeftPanel(p.id)}
          />
        ))}
      </calcite-action-bar>
      <aside className={`ps-side left ${open ? "" : "closed"}`} aria-label="Workspace panel" aria-hidden={!open}>
        {PANELS.filter((p) => visited.has(p.id)).map((p) => (
          <div key={p.id} className="ps-panel-host" hidden={active !== p.id}>
            {p.id === "contents" && <ContentsPanel />}
            {p.id === "layers" && <LayersPanel />}
            {p.id === "upload" && <UploadPanel />}
            {p.id === "bookmarks" && <BookmarksPanel />}
            {p.id === "selection" && <SelectionPanel />}
            {p.id === "editing" && <EditingPanel />}
          </div>
        ))}
        <Resizer cssVar="--ps-left-w" axis="x" min={260} max={640} direction={1} label="Resize left panel" />
      </aside>
    </>
  );
}
