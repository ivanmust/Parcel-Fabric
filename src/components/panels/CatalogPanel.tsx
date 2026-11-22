import { useEffect, useRef, useState } from "react";
import Portal from "@arcgis/core/portal/Portal.js";
import PortalQueryParams from "@arcgis/core/portal/PortalQueryParams.js";
import type PortalItem from "@arcgis/core/portal/PortalItem.js";
import { useApp } from "../../stores/appStore";
import { useMapController } from "../../hooks/useMapController";
import { createLayerFromPortalItem } from "../../gis/layers/layerLoader";
import { describeArcGISError } from "../../services/arcgis/serviceMetadata";

const TYPES = ["Feature Service", "Map Service", "Vector Tile Service", "Image Service", "Scene Service"];
type Scope = "org" | "mine";

/** Search the organisation's Portal content and add layers to the map. */
export function CatalogPanel() {
  const user = useApp((s) => s.user);
  const ctrl = useMapController();
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>("org");
  const [results, setResults] = useState<PortalItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const portalRef = useRef<Portal | null>(null);

  useEffect(() => {
    let stale = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        portalRef.current ??= new Portal({ authMode: "immediate" });
        const portal = portalRef.current;
        await portal.load();
        const typeQ = `(${TYPES.map((t) => `type:"${t}"`).join(" OR ")})`;
        const parts = [typeQ];
        if (text.trim()) parts.unshift(`(${text.trim().replace(/[()"]/g, " ")})`);
        if (scope === "mine" && user) parts.push(`owner:"${user.username}"`);
        else if (portal.id) parts.push(`orgid:${portal.id}`);
        const res = await portal.queryItems(
          new PortalQueryParams({ query: parts.join(" AND "), num: 30, sortField: "modified", sortOrder: "desc" }),
        );
        if (stale) return;
        setResults(res.results);
        setTotal(res.total);
      } catch (e) {
        if (stale) return;
        setError(describeArcGISError(e));
        setResults([]);
      } finally {
        if (!stale) setLoading(false);
      }
    }, 350);
    return () => {
      stale = true;
      clearTimeout(handle);
    };
  }, [text, scope, user]);

  const add = async (item: PortalItem) => {
    if (!item.id) return;
    setAdding(item.id);
    try {
      const layer = await createLayerFromPortalItem(item.id);
      ctrl.addLayer(layer);
      useApp.getState().notify("success", "Layer added", item.title ?? undefined);
      void ctrl.goToLayer(layer);
    } catch (e) {
      useApp.getState().notify("danger", "Could not add item", describeArcGISError(e));
    } finally {
      setAdding(null);
    }
  };

  return (
    <calcite-panel heading="Catalog" description="Portal content you can access" loading={loading || undefined}>
      <div className="ps-panel-body">
        <calcite-input-text
          scale="s"
          icon="search"
          clearable
          placeholder="Search services"
          value={text}
          oncalciteInputTextInput={(e) => setText((e.target as HTMLElement & { value: string }).value)}
        />
        <calcite-segmented-control
          width="full"
          scale="s"
          oncalciteSegmentedControlChange={(e) => setScope((e.target as HTMLElement & { value: string }).value as Scope)}
        >
          <calcite-segmented-control-item value="org" checked={scope === "org" || undefined}>
            Organisation
          </calcite-segmented-control-item>
          <calcite-segmented-control-item value="mine" checked={scope === "mine" || undefined}>
            My content
          </calcite-segmented-control-item>
        </calcite-segmented-control>
        {error && (
          <calcite-notice open kind="danger" scale="s">
            <div slot="message">{error}</div>
          </calcite-notice>
        )}
        {results && !error && <div className="muted" style={{ fontSize: 12 }}>{total} items</div>}
        {results?.length === 0 && !error && !loading ? (
          <div className="ps-empty">
            <calcite-icon icon="collection" scale="l" />
            <h4>No services found</h4>
            <p>Try another search term or switch scope.</p>
          </div>
        ) : (
          <calcite-list label="Portal items" scale="s">
            {results?.map((item) => (
              <calcite-list-item key={item.id} label={item.title ?? item.id ?? ""} description={`${item.type} · ${item.owner}`}>
                {item.thumbnailUrl && (
                  <img slot="content-start" src={item.thumbnailUrl ?? undefined} alt="" width={40} height={27} style={{ objectFit: "cover", borderRadius: 3 }} />
                )}
                <calcite-action
                  slot="actions-end"
                  icon="add-layer"
                  text="Add to map"
                  loading={adding === item.id || undefined}
                  onClick={() => void add(item)}
                />
              </calcite-list-item>
            ))}
          </calcite-list>
        )}
      </div>
    </calcite-panel>
  );
}
