# Strava Heatmap extension

This browser extension seamlessly integrates the [Strava Global Heatmap](https://www.strava.com/maps/global-heatmap) into popular mapping editors, including the OpenStreetMap [iD editor](https://www.openstreetmap.org/edit?editor=id) and [GPX Studio](https://gpx.studio/app), enhancing your mapping and route analysis capabilities.

<img src="./images/screenshot1.png" width="48%"/>&nbsp;<img src="./images/screenshot2.png" width="48%"/>

## Pre-requisites

### Strava account

If you don’t already have a Strava account, you’ll need to create one (free) to use the Strava Heatmap.

1. Go to https://www.strava.com/register/free
2. Sign up using Google, Apple, or your email

## Installation

### Chrome

Open the [Chrome extension page](https://chrome.google.com/webstore/detail/eglbcifjafncknmpmnelckombmgddlco) for the extension.

1. Click `Add to Chrome`.
2. Confirm permissions by selecting `Add extension`.
3. Chrome will briefly display a popup and show the new extension icon in the top-right toolbar.
4. Right-click the extension icon and choose `Pin` to keep it visible.
5. Alternatively, open the puzzle-piece Extensions menu and click the 📌 next to Strava Heatmap extension.

### Firefox

Open the [Firefox add-on](https://addons.mozilla.org/en-US/firefox/addon/strava-heatmap/) for the extension.

1. Click `Add to Firefox`.
2. Confirm permissions by selecting `Add`.
3. Chrome will briefly display a popup and show the new extension icon in the top-right toolbar.
4. Make sure `Pin extension to toolbar` is selected and click `OK`.
5. Alternatively, right-click the extension icon and choose `Pin` to keep it visible.

### Versions

See the [Changelog](./CHANGELOG.md) for details.

### Instructions

## OpenStreetMap iD editor

To enable the Strava Heatmap in the iD editor:

1. Open the iD editor: https://www.openstreetmap.org/edit?editor=id
2. Press B or click Background settings, then scroll to Overlays.
3. Select a Strava Heatmap overlay from the list.
4. If you see the message "Click the Strava Heatmap extension icon to log into Strava…", click the red extension icon to authenticate.
5. After logging in, use the green extension icon to configure heatmap layers — choose activity type, color, and manage layer order or deletion.
6. In the editor, press Shift + Q to toggle the heatmap, and Shift + W to toggle data visibility.

### Strava Slide (iD)

1. Log into Strava with the extension and enable a Strava heatmap overlay.
2. Draw a rough **open line** close to the desired trail, or select an existing line.
3. Press **Shift + S**, or right-click the selected line and choose **Slide**
   (the blue-arrow/trail icon).
   To slide only part of a way, select two or more of its vertices instead.
4. If several Strava overlays are enabled, choose the activity to follow.
5. Review the result before saving. Use iD's normal **Undo** to restore the original line.

Slide runs locally in vanilla JavaScript, without the discontinued Strava Slide
server. Inspired by [Paul Mach's Slide](https://github.com/paulmach/slide/) and
[Strava's iD integration](https://github.com/strava/iD), this implementation follows
density-weighted shortest paths through an ordered corridor,
rather than using the strong bending/smoothing forces that can cut across tight
curves. It adds vertices where necessary while retaining original node IDs and
way tags. Endpoints, tagged nodes, shared junctions and relation-member nodes are
kept fixed. All changes are a single undoable edit; cancellation or errors leave
the map unchanged.

After tracing, a heatmap-aware **Douglas–Peucker** pass removes redundant inserted
vertices with a **2 m geometric tolerance**. The earlier 1.2 m tolerance retained
pixel stair-steps as small angular kinks. A density check vetoes shortcuts that
would leave a narrow trail, and all original nodes remain present. This is
simplification rather than coordinate-averaging smoothing, so it does not move
retained vertices or round off bends indiscriminately. Closely spaced original
or protected nodes are intentionally not deleted to enforce a spacing rule.

The selected activity and palette are preserved. Density is read directly from
Strava's ordered PNG palette indices, **not RGB brightness**: even the palette
called `gray` is non-monotonic in brightness and previously caused Slide to trace
the edges of trails. Zoom 15 is preferred, with correctly scaled zoom-14
parent fallback for missing tiles. The initial line must be close to the desired
trail (a 24 m search corridor and 18 m interior-node snapping radius). At forks or
ambiguous parallel trails, add guide vertices. Weak/disconnected heatmap data,
closed/area ways, missing OSM data and shifted heatmap imagery are not supported.
Slide is currently available in iD, not GPX.studio. Heatmap activity density is
not evidence of legal access; always review geometry and access tags yourself.

---

### GPX.studio editor

To enable the Strava Heatmap in GPX.studio:

1. Open GPX.studio: https://gpx.studio/app
2. Hover over the layers menu icon then scroll to Overlays.
3. Choose a Strava Heatmap overlay from the list.
4. If you see the message "Click the Strava Heatmap extension icon to log into Strava…", click the red extension icon to authenticate.
5. Once logged in, use the green extension icon to configure, reorder, or delete heatmap layers by activity and color.

### Troubleshooting

**Q: “Click the Strava Heatmap extension icon to log into Strava and enable the heatmap.” — What does this mean?**  
**A:** This message appears if you're not logged in to Strava AND haven’t visited the [Strava Global Heatmap](https://www.strava.com/heatmap). Just click the extension icon to sign in and authorize access.

### Feature and Bug Requests

Submit issues and feature requests in the [Issues](https://github.com/julcnx/strava-heatmap-extension/issues) section above.

## Extension Background

Previously, accessing Strava heatmap in OpenStreetMap iD editor required a tedious process of extracting Strava website cookies and generating a temporary URL that would expire after a week.

The [JOSM Strava Heatmap Extension](https://github.com/zekefarwell/josm-strava-heatmap) simplified this process, but due to the lack of support for custom overlays in the iD editor, users could only add the URL as a custom background.

With this extension, you can now automatically access all Strava activities as Heatmap overlays, eliminating the need for manual URL management.

To learn more about using the Strava Heatmap in OpenStreetMap, visit the [Strava wiki](https://wiki.openstreetmap.org/wiki/Strava).

### Support for Other Sites

This extension currently supports the iD editor and [gpx.studio](https://gpx.studio). I'm not taking on additional sites at the moment. If you'd like to add support for another tool, feel free to fork the project.

- For JOSM, check out the [JOSM Strava Heatmap Extension](https://github.com/zekefarwell/josm-strava-heatmap).
- For RapidId, refer to the [RapId Power User Extension](https://github.com/emersonveenstra/rapid-power-user-extension/).
