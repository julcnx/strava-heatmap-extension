# Changelog

## Versions

### `0.15.0` (2026-10-13)

- [iD] New **Strava Slide**: press Shift+S, or right-click a line and choose Slide, to snap a roughly drawn line onto the heatmap trail. One Undo restores it. By @rene78 (#43, #45):
  - Local, dependency-free port inspired by Paul Mach's Slide and Strava's iD integration: traces the heatmap ridge between the line's points, so tight switchbacks are kept
  - Finds faint trails and lines drawn far from the trail, and handles missing heatmap tiles
  - Removes duplicate points, keeps tags and connections, and never edits a line changed while Slide was running
  - Activity picker when several Strava overlays are enabled, progress dialog with cancel, theme-aware icon, and support for Strava's new grayscale tiles
- [iD] Strava Slide improvements:
  - The line's ends, junctions, tagged nodes and relation members stay in place
  - Works on closed lines; sections without a usable heatmap trail are left as drawn instead of failing the whole line
  - Ignores the heat of other mapped roads and paths next to the line, including the bright edges of wide roads, so a stronger parallel trail does not pull it; tunnels under the line are not, as they have no heat of their own
  - Avoids running along other roads into a junction, folding back over itself, spikes and near-duplicate points; one Shift+S runs two smoothing passes
  - Follows the trail's curves, bends and hairpins more closely, adding points to round the turns and dropping needless ones on straight stretches; tight drawn switchbacks the heatmap cannot show are kept as drawn
  - Leaves parts with no heatmap trail exactly as drawn, and traces the trail into junctions instead of keeping the drawing's approach to them
  - Shift+S again on a line already on its trail leaves it unchanged
  - Shift+S works right after drawing a line; Slide sits after Straighten in the edit menu; clearer, colored messages
  - Downloads the missing OSM data around the line by itself, instead of asking you to pan along it first
- [iD] Show a one-time notice on mapping responsibly with the Strava heatmap
- [iD] List the extension's shortcuts (Shift+Q, Shift+W, Shift+S) in iD's keyboard shortcuts panel

### `0.14.0` (2026-10-12)

- [iD] Switch to Strava's new `grayscale` heatmap tiles (`v=20`), colorized in the browser with Strava's exact color palettes (#41)
- New color palettes matching Strava: Blue, Purple, Orange, Sunset, Pink, Contrast, Blue-Red
- Saved layers using removed colors are migrated automatically: Hot → Orange, Gray → Contrast
- [gpx.studio] Keep using the legacy pre-colored tiles for now, new palettes use the closest legacy color
- Validate Strava credentials against the `grayscale` tiles

### `0.13.8` (2026-09-09)

- Add more sport types to the Other Sports group (Badminton, Basketball, Cricket, Dance, Golf, Handcycle, Inline Skate, Padel, Physical Therapy, Pickleball, Rock Climb, Roller Ski, Skateboard, Football (Soccer), Tennis, Volleyball, Wheelchair)

### `0.13.7` (2026-08-12)

- [iD] Fix Shift+Q / Shift+W overlay shortcuts not re-binding reliably after iD 2.42.0

### `0.13.6` (2026-02-19)

- Enable missing redirect for strava.com/onboarding

### `0.13.5` (2025-12-09)

- Replace automatic new-tab opening on install/updates with a clickable notification.

### `0.13.4` (2025-12-07)

- Enabled clickable notifications

### `0.13.3` (2025-12-04)

- [iD] Fix issue where overlays were not automatically reselected after a refresh or update
- Enhance badge icon and context menus
- Add notifications to improve workflow
- Improve appearance of the About page
- Reset credentials automatically on Strava logout

### `0.13.2` (2025-11-29)

- Setup About page to display on installation, after updates, and via the context menu.
- Added a permissions check and notify the user if any required permissions are missing.
- [gpx.studio] Disabled SPA navigation workaround after GPX.studio update.

### `0.13.1` (2025-11-28)

- [gpx.studio] Fixed SPA navigation to “/app” that blocked browser from re-injecting content scripts.

### `0.13.0` (2025-11-28)

- [gpx.studio] Initial integration.
- Generalize the extension by removing all iD-specific references from the manifest, package, and documentation.

### `0.12.2` (2025-08-04)

- [iD] Fix crash when pressing Shift+W while drawing geometries.

### `0.12.1` (2025-07-22)

- [iD] Ensure the restore unsaved changes prompt appears after reload.
- [iD] Maintain non-Strava layers above Strava layers.

### `0.12.0` (2025-05-23)

- [iD] Preserve layer stacking order based on the popup configuration.
- [iD] Add the Shift+Q shortcut to the keyboard shortcuts help panel.

### `0.11.1` (2025-05-19)

- [iD] Fixed selection of previously used overlays.

### `0.11.0` (2025-05-12)

- Add popup with configurable Strava layers (activity type and color options).
- Remove unneeded check-updates mechanism.

### `0.10.1` (2025-05-07)

- [iD] Fixed Shift+Q overlay toggle keyboard shorcut conflicting with area squaring.

### `0.10.0` (2025-04-24)

- Extension Icon: Shows Strava authentication state with login on click
- Cookie Handling: Auto-refreshes cookies and prompts re-login when expired.
- Overlay Menu: Improved colors, Shift+Q toggles visibility, remembers last settings.
- Fallback UX: Adds login guidance on blurred tiles.
- Context Menu: Moved to the extension icon.

### `0.9.3` (2025-03-30)

- Updated Strava URLs and expanded cookie support.
- Fixed layer injection issue on editor load.
- Added update notification dialog on editor launch.
- Show hint on Heatmap tiles when user is not logged into Strava.

### `0.9.2` (2025-03-20)

- Fixed the issue with the context menu handler

### `0.9.1` (2025-03-20)

- Added support for right-click context menus, providing quick access to useful links
- Enabled notifications upon installation and update of the extension
