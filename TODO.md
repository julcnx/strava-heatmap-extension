# TODO

What's next, in order. Update it whenever something is done, added or postponed.

## 0.15.5: release planned for 2026-11-29

Branch `v0.15.5`, code complete.

Before:

- [ ] Retest in Chrome and Firefox, after the layer names lost their emoji: swatches in iD's overlay list, layers still ticked, Shift + H and Shift + Q, names in the Strava Slide dropdown, gpx.studio layers
- [ ] Check #43 for 0.15.4 reports: Slide fixes go in first

Release (see CLAUDE.md):

- [ ] Set the date in `CHANGELOG.md`
- [ ] `npm test` and `npm run slide-lab:check`
- [ ] `npm run build`
- [ ] Push `master` and `v0.15.5`
- [ ] Upload both zips, and the three screenshots in `images/`, to the Chrome and Firefox stores
- [ ] Once live: close #32 (Shift + H) and #50 (menu duplicate id errors), tell #43 if Slide changed

## Next versions

1. [ ] `slide-lab:check` with junctions moving, as in iD (it keeps them pinned, so it missed the 450064350 kink). Do it before any other Slide change
2. [ ] Slide: when a line is too long, slide the part in view, up to the 16 tiles, and say so
3. [ ] Tests for the popup, the icon menu and the overlay list
4. [ ] Slide: rough new lines. Points off the trail block the sections on both sides; ignoring them works but draws wrong lines, so it needs a single-heat check, and only for lines not uploaded yet
5. [ ] gpx.studio: send the palette swatches as icons, if gpxstudio/gpx.studio#411 is accepted (a PR was offered)

## Small things

- [ ] Slide: one Flattop Sunnyside tip (way 332538430) bulges towards the shoulder of the bend
- [ ] Slide: Hunter Pass (way 1192973305) is slightly worse than in 0.15.4 beta.1
- [ ] Slide lab: South Fork Valley (way 239468111) needs too many tiles, let the lab slide a section
- [ ] Login notification may not clear if Chrome stops the background worker (not reproduced)
