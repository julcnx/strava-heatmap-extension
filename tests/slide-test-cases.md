# Strava Slide: test cases, known problems and plan

Real-world lines reported by mappers, used to test Slide in iD before each
release, the problems they show, and the plan for v0.16.0. Feedback comes from [#43](https://github.com/julcnx/strava-heatmap-extension/issues/43)
and [#46](https://github.com/julcnx/strava-heatmap-extension/issues/46) (v0.15.0 beta).

## Test locations

| # | Problem | Reporter | URL |
|---|---|---|---|
| 1 | Junction end (north) moves and drags the connected ways | rene78 (Example 1) | https://www.openstreetmap.org/edit?way=1568166643#map=19/36.764550/-4.406288 |
| 1 | Junction end (north) moves and drags the connected ways | rene78 (Example 2) | https://www.openstreetmap.org/edit?way=779356025#map=18/36.753742/-4.397124 |
| 2 | Too many points removed at switchbacks | rene78 (Example 3) | https://www.openstreetmap.org/edit?way=438832711#map=19/36.761516/-4.404432 |
| 3 + 4 | Doesn't slide at all; after disconnecting the north end, folds onto the stronger trail to the east | rene78 (Example 4) | https://www.openstreetmap.org/edit?way=223115682#map=19/36.757817/-4.395125 |
| 3 | Slides onto the stronger neighbouring trail | rene78 (Example 5) | https://www.openstreetmap.org/edit?way=1568177943#map=19/36.750768/-4.399904 |
| 5 | Needs two Slides (Bibbulmun Track, Munda Biddi just south) | EwenH (#43) | https://www.openstreetmap.org/edit#map=16/-34.51562/116.12378 |
| 6 | "Download the OSM data" message although the whole road was viewed (Carters Gap Road) | EwenH (#46) | https://www.openstreetmap.org/edit#map=16/-37.61235/145.68486 |
| 8 | Stream and track crossings stay in place; had to disconnect them to slide the road | EwenH (#46) | same as above |
| 9 | New short line slides a little wobbly where there is little Strava activity | EwenH (#46) | same as above |
| 1 | Mawson Trail: junctions with boundaries (bad mapping) are moved | EwenH (#43) | https://www.openstreetmap.org/edit?node=431409640#map=19/-31.632018/138.627878 |
| 2 | Mawson Trail: S-bend and creek-crossing double back not sharp enough | EwenH (#43) | same as above |
| 10 | Unmapped track south of the airstrip, north of the creek: needed several tries with more drawn points to slide the whole line | EwenH (#43) | https://www.openstreetmap.org/edit?node=431409640#map=16/-31.64182/138.62248 |
| 11 | Hard case: walking track climbing a creek to a waterhole (doesn't have to work, good stress test) | EwenH (#43) | https://www.openstreetmap.org/edit?node=431409640#map=18/-31.134589/138.593442 |

EwenH's links have no way ID: find the Bibbulmun Track section and Carters Gap
Road by hand at those positions. The Mawson Trail links (node 431409640) only set
the map position; the way is the route at that spot. EwenH left his Mawson Trail
edits unsaved so they can be compared. He also tested ten other lines in the
beta without problems.

## Problems, causes and fixes

### 1. Junction or line end moves to the wrong spot

Status: fixed in v0.15.0, to confirm on Examples 1 and 2 and on the Mawson
Trail in iD. Junctions are fixed again (`fixedIndices`); only free line ends may
move, up to 18 m. The Mawson Trail is wrongly connected to admin boundaries, and
the beta moved those junctions too (EwenH agrees they should not be connected).

Untagged junctions and line ends may move up to the snap radius (18 m), see
`limitedIndices` in `slide/index.js`. At a junction the other way's heat is as
strong as this one's, so the snap can land on or next to the other way, and the
connected ways bend with it. `trimJunctionOverlaps` only handles the line running
along the other way, not where the first snap lands.

Fix options:
- Recommended: keep junctions fixed again (like Paul Mach's Slide), only let free
  line ends move. The `approachFactor` code already avoids hooks next to fixed points.
- Or let a junction move only along the other way's own segments.
- Either way, keep junctions with non-highway ways (waterways, area outlines) fixed.

### 2. Switchbacks and tight bends lose points

Status: fixed in v0.15.0, to confirm on Example 3 and on the Mawson Trail
S-bend and creek-crossing double back in iD (EwenH: much closer than the drawn
line, but the sharp curve is still cut).

Example 3 (screenshot from the user, zoom 18 at 36.761515/-4.404432) shows a
113° bend drawn by a single point, with its neighbours about 20 m away: the line
cuts the inside of the bend instead of following it. The spike rule (more than
150°) is not involved.

Reproduced with a synthetic bend (radius 6 m) in
`tests/slide-algorithm.test.mjs`: the traced path does follow the bend and
Douglas–Peucker keeps a point on it, but `removeSmallTurns` then deletes it,
because its triangle with its neighbours is only 26 m², below
`minTriangleSquareMeters` (40 m²). An area limit hits tight bends hardest: the
closer the neighbours, the larger the offset a point needs to survive (a
point 3 m off a 17 m chord is dropped). The line then ran 3.8 m off the trail.

Fix: `minTriangleSquareMeters` 40 → 10 m². The bend keeps its point and the
line stays within about one heatmap pixel (2.2 m). Synthetic hairpins (160° and
175°) are traced as a rounded apex of several points turning 39–80°, so the
spike rule does not remove them.

To check in iD: Example 3, and that straight wide roads do not get small
stair-step kinks back (the reason `removeSmallTurns` was added; synthetic tiles
do not produce them).

### 3. Parallel trails and roads

Status: partly fixed in v0.15.0, to confirm on Examples 4 and 5 in iD. Option 1
below is done (`maskOtherWays` in `slide/algorithm.js`): heat within 5 m of
other mapped highways is ignored (fading back by 8 m), except within 15 m of a
junction with the line. Beyond that, up to 20 m, heat that keeps fading away
from the other way (its core, then a falling flank) is ignored too: a wide
road's bright edge pulled way 450064354 across a dark gap. Heat that stops
falling (a plateau, or a rise beyond a gap) is another trail and is kept;
paths running inside a road's band (Example 4) are then left as drawn. Still
open: unmapped parallel trails, and a stronger
mapped trail within 15 m of a junction (the hook case in Example 4). A
junction trim that runs more than 30 m now leaves that stretch as drawn instead
of reducing the line to a straight chord.

Fixing the end points does not help: interior points snap freely within 18 m,
widening up to 60 m. Paul Mach's Slide had the same problem.

Causes:
- The tracking surface rates each pixel against the strongest heat within 12 m,
  so a weaker trail next to a stronger one scores below 1.
- `snap()` has only a mild distance penalty (`0.12 · (d/r)²`), so the stronger
  ridge wins.
- The path cost `8(1−d)²` also strongly prefers the stronger ridge.

Fix options, best first:
1. Ignore heat already explained by other mapped ways: mask or penalise pixels
   within a few metres of other highways (outside junction zones).
2. Snap to the nearest ridge above the threshold, not the strongest.
3. Make leaving the drawn line cost more, and don't widen the snap to 60 m for
   existing mapped ways.
4. Smaller contrast radius (about 6 m); needs testing, amplifies noise.

Two real unmapped parallel trails stay ambiguous: the user must slide a range or
fix by hand.

### 4. Example 4 doesn't slide at all

Not explained from the code. Possible causes: the north end connects to a bridge
or a way shorter than 40 m (`anchorsStructure`), the "Slide attempted to move a
protected node" check, or no section finding a trail. Reproduce and note the
exact message.

### 5. Some lines need a second Slide

Slide already runs two passes (`slideLineTwice`). Option: repeat until the line
stops changing (at most 3 passes). Ask for before/after screenshots first.

### 6. "Download the OSM data around the line before sliding"

Every point must sit in a zoom-16 OSM tile that iD has loaded. iD draws the whole
way as soon as one tile with it is loaded, so the line looks complete while far
tiles are not. The check must stay: without it, unknown parent ways would let
cleanup move or delete a real junction.

Planned for v0.16.0: at run time, load the missing z16 tiles with
`context.loadTileAtLoc(loc, callback)` (verify it exists in iD), then rebuild
the selection and continue.

### 7. "Slide needs too many tiles"

The line's bounding box (padded by 92 m) must fit in 16 z15 heatmap tiles
(about 4 × 4 km, less at high latitudes). The whole box becomes one raster at
about 14 bytes per pixel, so cost grows with the box area, not the line length.

Planned for v0.16.0: split long lines into overlapping chunks that each fit the
budget, keep each chunk up to boundary point B, start the next chunk with B fixed
at its slid position, share the tile cache, then clean and apply one action (one
Undo) on the joined result.

### 8. Crossings stay in place (#46)

EwenH had to disconnect the stream crossings and other track junctions on Carters
Gap Road: otherwise Slide moved the points between them but kept the crossings
where they were. He thinks this is the correct behaviour and suggests documenting
it.

In the beta, untagged junctions may move up to 18 m, so a crossing staying put
means it was fixed: a tagged node (ford, culvert), a relation member (for example
a waterway relation), a junction with a bridge, tunnel or way shorter than 40 m
(`anchorsStructure`), or no trail found within 18 m. Check which one on Carters
Gap Road. If junctions become fixed again (problem 1), this is the expected
behaviour: document in the README that junctions stay in place and that
disconnecting them, then reconnecting after sliding, lets them move.

### 9. Wobbly result on a short, low-activity line (#46)

Expected with little heat: the ridge is noisy, and the contrast normalisation
amplifies faint noise. Nothing to fix for now; worth checking if smoothing more
on faint sections (larger `simplifyMeters` where the raw density is low) helps.

### 10. Rough new line needs more drawn points

EwenH, unmapped track near the Mawson Trail: it took a few attempts, adding
points, before the whole line slid. Likely causes: drawn points more than 18 m
from the trail (snap radius), or long segments where the trace leaves the
corridor and the section is left as drawn. Note which sections stay as drawn
with few points. Possibly documenting is enough ("draw a point at each bend,
within about 15 m of the trail").

### 11. Creek walking track (stress test)

EwenH's "gnarly" case: a walking track climbing up a creek to a waterhole,
probably faint, winding heat in a narrow valley. Not required to work; use it to
check that Slide leaves bad sections as drawn rather than producing a wrong line.

### Other feedback

- EwenH (#46): add a reference to Strava and Strava Slide in the changeset
  sources by default after a Slide. Check first whether iD's `imagery_used` tag
  already lists the Strava overlay. Setting `source` or the comment for the user
  is intrusive, so treat it as optional.
- The title of #46, "Cannot align existing short track", is about this message:
  the existing road could not be slid at all, while a new test line worked. Nothing
  in the code refuses a line for being short (2 points is enough). The only rule
  about short ways is that a junction with a way shorter than 40 m stays fixed
  (`SHORT_WAY_METERS`), which may explain some crossings in problem 8.
- EwenH (#46) could not reproduce the "Download the OSM data" message later,
  which fits the explanation in problem 6: it depends on which parts were viewed
  at zoom 16 or closer. On #43 he put it down to user error; auto-download
  (v0.16.0) still removes the trap.

## Plan for v0.16.0

Start the branch as described in `CLAUDE.md` (version bump and CHANGELOG entry
as the first commit). Problems 1, 2 and 4 above should be fixed before the
v0.15.0 release, or moved here if they are not.

### 1. Multi-line Slide

- Select several lines: one Shift+S or menu entry, one Undo.
- Process the lines one after the other. A junction shared by two selected lines
  moves at most once.
- Skip unsupported lines (areas, bridges, tunnels, too many points) and show a
  summary message, for example "3 lines slid, 1 skipped (bridge)".
- Limit to about 10 lines per Slide.
- Needs the two changes below: several lines quickly exceed both the
  downloaded-data check and the tile limit.

### 2. Download missing OSM data automatically (problem 6)

1. In `operation.disabled()`, stop refusing when points are in OSM tiles that
   are not loaded.
2. When Slide starts, collect the distinct z16 tiles of those points and call
   `context.loadTileAtLoc(loc, callback)` for each (verify it exists in the
   live iD first).
3. Show "Loading OSM data…" in the progress dialog and wait for all callbacks.
4. Rebuild the selection from the new graph: loading may reveal new junctions,
   so `fixedIndices` and `protectedIndices` must be computed after loading.
5. If a load fails, or a connection is still hidden, keep today's message.

Cost: about 20 OSM API calls for a 10 km line, the same as panning along it.

### 3. Split long lines automatically (problem 7)

1. Split the selected points into consecutive chunks whose padded bounding box
   fits the 16-tile budget, overlapping by a few points.
2. Slide chunk 1 with `slideLineTwice`, but keep its result only up to the
   boundary point B, so B was traced with the trail on both sides.
3. Slide chunk 2 starting from B's slid position, with B fixed. Repeat.
4. Share the tile cache of `loadSlideTiles` between chunks so overlapping tiles
   are downloaded once.
5. Run `cleanSlideResult` and `createSlideAction` once on the joined result:
   one Undo step.

Keep upper limits: 1000 selected points, 2000 nodes per OSM way, and maybe about
50 km in total to stay kind to Strava's servers.

Rejected alternatives: raising the tile limit to 36 (diagonal lines still stuck
at about 6 km, about 130 MB of memory), or a sparse raster holding only the
corridor tiles (every pixel lookup in `algorithm.js` assumes one rectangle).

### 4. Parallel trails (problem 3)

Bigger algorithm change, can ship with v0.16.0 or later:
1. Mask or penalise heat within a few metres of other mapped highways.
2. Snap to the nearest ridge, not the strongest.

Test on Examples 4 and 5.

### Maybe: OSM public GPS traces as a Slide source

iD overlay `osm-gps`, tiles `{a,b,c}.gps-tile.openstreetmap.org/lines/{z}/{x}/{y}.png`
(zoom 0 to 20, open CORS, no login). 256 px indexed PNGs with a per-tile
64-color palette: hue seems to be direction, opacity or brightness the amount of
traces, so it needs a new decoder mode. Answers the OSM community concern that
Slide relies only on Strava, but OSM traces are usually few and of low quality:
decide before building it.

### Later (v0.17.0 or after)

- **Find unmapped trails:** detect bright heat with no OSM way nearby, draw the
  candidates as a dashed overlay, and click one to create a normal way
  (connected at its ends, iD's preset picker opens). One at a time and reviewed
  by the mapper, because of OSM's automated-edits rules. Filter out shortcuts and
  off-trail heat (minimum length, consistent heat, activity). Announced on #43.
- Run the second pass only where sharp turns remain, for speed.
- gpx.studio grayscale tiles once gpxstudio/gpx.studio#399 is merged.
