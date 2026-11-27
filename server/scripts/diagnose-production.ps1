param(
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$Domain = ""
)
$server = Join-Path $AppDir "server"
function Section($title) { Write-Host "`n=== $title ===" -ForegroundColor Cyan }

Section "0. Paths"
"AppDir = $AppDir"
"server\dist\index.js exists = $(Test-Path (Join-Path $server 'dist\index.js'))"
"dist\index.html exists      = $(Test-Path (Join-Path $AppDir 'dist\index.html'))"
"server\.env exists          = $(Test-Path (Join-Path $server '.env'))"
"node version                = $(try { node --version } catch { 'NODE NOT FOUND' })"

Section "1. Is something listening on port 4001?"
$listen = Get-NetTCPConnection -LocalPort 4001 -State Listen -ErrorAction SilentlyContinue
if ($listen) {
  $listen | ForEach-Object { "listening on $($_.LocalAddress):4001, process id $($_.OwningProcess)" }
  Get-Process -Id ($listen | Select-Object -First 1).OwningProcess -ErrorAction SilentlyContinue | ForEach-Object { "process: $($_.ProcessName) $($_.Path)" }
} else { "NOTHING is listening on 4001 -> the Node API is not running" }
Get-Service -Name ParcelFabricAPI -ErrorAction SilentlyContinue | ForEach-Object { "service ParcelFabricAPI: $($_.Status)" }

Section "2. .env (non-secret values only)"
$cfg = @{}
if (Test-Path (Join-Path $server '.env')) {
  Get-Content (Join-Path $server '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim() } }
}
foreach ($k in 'NODE_ENV','PORT','APP_ORIGINS','PORTAL_URL','ARCGIS_SERVER_URL','PARCEL_SERVICE_PATH','LAIS_ARCGIS_REFERER','LAIS_WRITE_MODE','LAIS_PARCEL_LAYER_URL','API_DOCS') { "{0,-22} = {1}" -f $k, $cfg[$k] }
"{0,-22} = {1}" -f 'LAIS_API_KEY length', ("" + $cfg['LAIS_API_KEY']).Length
"{0,-22} = {1}" -f 'LAIS_ARCGIS_USERNAME', ($(if ($cfg['LAIS_ARCGIS_USERNAME']) { 'set' } else { 'MISSING' }))
"{0,-22} = {1}" -f 'LAIS_ARCGIS_PASSWORD', ($(if ($cfg['LAIS_ARCGIS_PASSWORD']) { 'set' } else { 'MISSING' }))
$key = $cfg['LAIS_API_KEY']

Section "2b. LAIS editing-done flow (GIS -> LAIS webhook, then LAIS approve)"
"{0,-22} = {1}" -f 'LAIS_EDITING_DONE', $cfg['LAIS_EDITING_DONE']
"{0,-22} = {1}" -f 'LAIS_WEBHOOK_KEY length', ("" + $cfg['LAIS_WEBHOOK_KEY']).Length
$hook = $cfg['LAIS_WEBHOOK_URL']
if ($hook -match '^(https?)://([^/:]+)(:(\d+))?') {
  $port = if ($matches[4]) { [int]$matches[4] } elseif ($matches[1] -eq 'https') { 443 } else { 80 }
  "LAIS_WEBHOOK_URL host   = $($matches[2]):$port ($($matches[1]))"
  if ($matches[1] -eq 'http') { "WARNING: plain http - the LAIS key travels unencrypted; ask LAIS for https." }
  # Connection test only: opens a TCP connection and closes it. Nothing is sent to LAIS.
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ok = $client.ConnectAsync($matches[2], $port).Wait(5000) -and $client.Connected
    if ($ok) { "LAIS endpoint REACHABLE from this server" } else { "LAIS endpoint NOT reachable from this server (timeout) - firewall/VPN between this server and LAIS needed" }
  } catch { "LAIS endpoint NOT reachable from this server: $($_.Exception.InnerException.Message)" } finally { $client.Close() }
} else { "LAIS_WEBHOOK_URL is empty - 'Editing done' cannot reach LAIS" }
if ($cfg['NODE_ENV'] -eq 'production' -and ("" + $cfg['APP_ORIGINS']) -notmatch 'https://') {
  "WARNING: APP_ORIGINS has no public https origin - editors on the public web app cannot sign in to the API"
}

Section "3. Direct to Node (bypassing IIS)"
curl.exe -s -i -m 20 http://127.0.0.1:4001/api/health
""
curl.exe -s -i -m 60 -H "X-API-Key: $key" http://127.0.0.1:4001/api/lais/transactions/NO-SUCH-ID

Section "4. Can Node on this server reach ArcGIS and sign in the LAIS account?"
$probe = Join-Path $env:TEMP "parcel-probe.mjs"
@'
const E = process.env;
const portal = (E.PORTAL_URL || "https://esrirw.rw/portal").replace(/\/+$/, "");
const server = (E.ARCGIS_SERVER_URL || "https://esrirw.rw/server").replace(/\/+$/, "");
const referer = E.LAIS_ARCGIS_REFERER || "http://localhost:5174";
const why = (e) => (e.cause && (e.cause.code || e.cause.message)) || e.message;
try { const r = await fetch(`${server}/rest/info?f=json`, { signal: AbortSignal.timeout(15000) }); console.log("ArcGIS Server reachable: HTTP", r.status); }
catch (e) { console.log("ArcGIS Server NOT reachable from Node:", why(e)); }
try {
  const r = await fetch(`${portal}/sharing/rest/generateToken`, {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: referer.replace(/\/+$/, "") + "/" },
    body: new URLSearchParams({ f: "json", username: E.LAIS_ARCGIS_USERNAME || "", password: E.LAIS_ARCGIS_PASSWORD || "", client: "referer", referer, expiration: "5" }),
  });
  const j = await r.json();
  console.log("LAIS account sign-in:", j.token ? "OK" : "FAILED " + JSON.stringify(j.error));
} catch (e) { console.log("Portal NOT reachable from Node:", why(e)); }
'@ | Set-Content -Encoding UTF8 $probe
Push-Location $server
node --env-file-if-exists=.env $probe
Pop-Location
Remove-Item $probe -ErrorAction SilentlyContinue

Section "5. IIS"
try {
  Import-Module WebAdministration -ErrorAction Stop
  Get-Website | ForEach-Object {
    $wc = Join-Path ([Environment]::ExpandEnvironmentVariables($_.physicalPath)) 'web.config'
    "site '$($_.Name)' state=$($_.State) path=$($_.physicalPath) bindings=$(($_.bindings.Collection | ForEach-Object { $_.protocol + ' ' + $_.bindingInformation }) -join ', ')"
    if (Test-Path $wc) {
      $x = Get-Content $wc -Raw
      "   web.config: proxies to 127.0.0.1:4001 = $($x -match '127\.0\.0\.1:4001'), httpErrors PassThrough = $($x -match 'existingResponse=.PassThrough')"
    } else { "   web.config: MISSING" }
  }
  $p = Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -ErrorAction Stop
  "ARR proxy enabled = $($p.enabled), timeout = $($p.timeout)"
} catch { "IIS check skipped: $($_.Exception.Message)" }

if ($Domain) {
  Section "6. Through IIS (public address)"
  curl.exe -s -i -m 60 "https://$Domain/api/health"
  ""
  curl.exe -s -i -m 60 -H "X-API-Key: $key" "https://$Domain/api/lais/transactions/NO-SUCH-ID"
}

Section "7. Last 30 lines of the API log"
$log = Join-Path $server 'logs\api.log'
if (Test-Path $log) { Get-Content $log -Tail 30 } else { "no log at $log (if the service writes elsewhere, paste that log's last lines)" }
