# drone-lightpaint

Route planner for drone light painting. An ESP32 with addressable LEDs hangs under an RTK drone flown by Dronelink; a camera on the ground takes a long exposure. This app designs the 3D path and per-waypoint colours, checks clearance against Google's photorealistic 3D tiles, and exports a KML.

Deployed as **Firefly** (`firefly.benscholer.com`, behind Cloudflare Access) from the homelab-config repo.

## Run

    npm start            # http://localhost:8080, data in ./data
    npm test             # geometry, KML, clearance, and API tests (no dependencies)

Needs Node 24+ (built-in `node:sqlite`). The container image is `ghcr.io/bscholer/drone-lightpaint`, built by CI on every push to `main`.

Open "Map keys" in the side panel:

| Key | Gives you |
| --- | --- |
| Google Maps API key (Map Tiles API enabled) | Google Earth photorealistic 3D tiles. Trees and buildings count as obstacles in the clearance check. |
| Cesium ion token | World Terrain + imagery. Bare earth only. |
| none | Flat Esri imagery, no terrain, clearance is not checked. |

Keys stay in the browser's localStorage and are never sent to the server.

## Saving

Routes live in SQLite (`/data/lightpaint.db`). Edits autosave about a second after you stop; the server keeps up to 25 earlier versions per route, at most one a minute (History… → Restore). Last write wins, so avoid editing one route in two tabs. If the page is served without the API, it falls back to the browser's localStorage. "Export file" / "Import file" move a route as JSON.

## Workflow

1. **Home**: click the takeoff spot. All altitudes are metres above it. Takeoff MSL is fetched from Open-Meteo (editable).
2. **Camera**: where the long-exposure camera stands. **Shape centre**: where the shape hangs.
3. Pick a shape, size, waypoint count, colours. "Face the camera" turns the shape's plane toward the camera so it reads correctly. Dashed yellow line is the preview. **Replace route** commits it.
4. Click waypoints to edit altitude, colour, or whether it is a sync-blink stop. **Add waypoint** / **Move selected** for freehand work.
5. Checks run automatically: clearance under every 5 m of the path, max height, range from home, estimated time. Bad segments show red.
6. **Download .dronelink** (or KML). **Cues JSON** is the per-waypoint colour list for the ESP32 side.

## Export formats

**`.dronelink`** (recommended): Dronelink's own plan file, so there is nothing to fix up after import. Waypoints come in with 0 s holds, 1 ft arrival distance and altitude, drone heading north and gimbal level with the horizon; horizontal speed is capped at the "Speed" setting. Altitudes are Dronelink's "above takeoff", which is exactly the planner's altitude, so the ellipsoid/MSL question does not arise. The format was read off a plan exported from Dronelink (JSON, LZ-UTF8 compressed, packed into 15-bit characters) and is checked against a real export; it is not from their SDK, which is proprietary. Not covered yet: per-waypoint camera actions, because none were in the sample.

**KML**: plain waypoints by default. Tick "Include coloured path lines" for a Google Earth preview, but do not import that into Dronelink: it reads the lines as extra waypoints.

KML altitude modes:

- **Ellipsoid** (default): WGS84 height = the home point's 3D-tile height + metres above takeoff, written as KML `absolute`. Google Earth reads `absolute` as MSL, so its preview sits roughly the geoid undulation (~30 m in Indiana) off vertically.
- `relativeToGround`: metres above the takeoff point.
- `absolute`: takeoff MSL + altitude. Needs the takeoff elevation.

## Layout

`server.js` API + static files · `public/src/geo.js` local tangent maths · `shapes.js` generators, corner-preserving resampling, placement · `route.js` sampling and clearance · `kml.js` KML and cue exports · `dronelink.js` .dronelink writer · `api.js` route-store client · `app.js` Cesium UI.
