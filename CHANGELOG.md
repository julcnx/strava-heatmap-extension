# Changelog

## Versions

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
