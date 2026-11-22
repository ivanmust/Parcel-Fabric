// Delete leftover PS_E2E_* test versions created by the automated UI tests.
import { env } from "./helpers.mjs";

const REFERER = "http://localhost:5174";
const VMS = "https://esrirw.rw/server/rest/services/ParcelFabric/VersionManagementServer";
const post = async (url, params) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${REFERER}/` },
    body: new URLSearchParams({ f: "json", ...params }),
  });
  return r.json();
};
const tok = await post("https://esrirw.rw/portal/sharing/rest/generateToken", {
  username: env.ARCGIS_USERNAME,
  password: env.ARCGIS_PASSWORD,
  client: "referer",
  referer: REFERER,
  expiration: "15",
});
const token = tok.token;
const infos = await post(`${VMS}/versionInfos`, { token });
const all = infos.versions ?? [];
console.log("versions:", all.map((v) => `${v.versionName} (editing=${v.isBeingEdited ?? "?"})`).join(", "));
for (const v of all.filter((v) => /\.PS_E2E_\d+$/.test(v.versionName))) {
  // Release locks left by an abandoned (closed) browser session, then delete.
  const locks = await post(`${VMS}/lockInfos`, { token });
  console.log("ALL LOCKS:", JSON.stringify(locks).slice(0, 800));
  const mine = (locks.locks ?? []).filter((l) => l.versionName === v.versionName);
  for (const l of mine) {
    const guid = l.versionGuid.replace(/[{}]/g, "");
    // Close the abandoned session the same way the app would (it is our own session id).
    if (l.lockType === "write")
      console.log("stopEditing", JSON.stringify(await post(`${VMS}/versions/${guid}/stopEditing`, { token, sessionId: l.sessionId, saveEdits: "false" })));
    console.log("stopReading", JSON.stringify(await post(`${VMS}/versions/${guid}/stopReading`, { token, sessionId: l.sessionId })));
  }
  const still = ((await post(`${VMS}/lockInfos`, { token })).locks ?? []).filter((l) => l.versionName === v.versionName);
  if (still.length) console.log("purgeLock", JSON.stringify(await post(`${VMS}/purgeLock`, { token, versionName: v.versionName })));
  const res = await post(`${VMS}/delete`, { token, versionName: v.versionName });
  console.log("delete", v.versionName, JSON.stringify(res));
}
const after = await post(`${VMS}/versionInfos`, { token });
console.log("remaining:", (after.versions ?? []).map((v) => v.versionName).join(", "));
