import { useEffect, useRef, useState } from "react";
import Bookmark from "@arcgis/core/webmap/Bookmark.js";
import Collection from "@arcgis/core/core/Collection.js";
import { useMapView } from "../../hooks/useMapController";
import { apiFetch } from "../../services/api/apiClient";
import { useApp } from "../../stores/appStore";

/** Bookmarks are stored per user on the Parcel Fabric server (`/api/bookmarks`). */
export function BookmarksPanel() {
  const view = useMapView();
  const [bookmarks] = useState(() => new Collection<Bookmark>());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ bookmarks: unknown[] }>("/bookmarks")
      .then(({ bookmarks: json }) => {
        if (cancelled) return;
        bookmarks.addMany(json.map((b) => Bookmark.fromJSON(b)));
        loaded.current = true;
        setState("ready");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState("error");
        useApp.getState().log("error", "bookmarks", "Could not load bookmarks", e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [bookmarks]);

  const scheduleSave = () => {
    if (!loaded.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await apiFetch("/bookmarks", { method: "PUT", json: { bookmarks: bookmarks.toArray().map((b) => b.toJSON()) } });
        useApp.getState().log("success", "bookmarks", `Saved ${bookmarks.length} bookmark(s)`);
      } catch (e) {
        useApp.getState().notify("danger", "Bookmarks not saved", (e as Error).message);
      }
    }, 600);
  };

  useEffect(() => {
    const h = bookmarks.on("change", scheduleSave);
    return () => h.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmarks]);

  return (
    <calcite-panel heading="Bookmarks" description="Saved map extents" loading={state === "loading" || undefined}>
      {state === "error" && (
        <div className="ps-panel-body">
          <calcite-notice open kind="danger" scale="s">
            <div slot="message">Bookmarks could not be loaded from the server.</div>
          </calcite-notice>
        </div>
      )}
      {view && state === "ready" && (
        <arcgis-bookmarks
          view={view}
          bookmarks={bookmarks}
          showAddBookmarkButton
          showEditBookmarkButton
          dragEnabled
          showFilter
          onarcgisBookmarkEdit={scheduleSave}
        />
      )}
    </calcite-panel>
  );
}
