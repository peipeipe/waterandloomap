# Design QA

- source visual truth path: `/mnt/c/Users/peipe/.codex/generated_images/019ff0bd-ff91-7ba0-918d-3c9d25d92371/exec-1883c552-54a8-45cc-b298-7e46abe7c586.png`
- implementation screenshot path: `app/implementation-mobile-screen.png` (generated locally and gitignored)
- intended viewport: 390 x 844 CSS pixels
- source pixel dimensions: 852 x 1820 pixels
- implementation pixel dimensions: 390 x 844 pixels
- density normalization: 1x capture at 390 x 844
- state: selected drinking-water marker with detail sheet open

## Full-view comparison evidence

Captured successfully with the Overpass API isolated to four deterministic fixtures. The implementation preserves the source direction: full-screen OpenStreetMap, blue/orange map pins, floating brand panel, current-location control, three-way filter, and selected-place detail surface. The implementation is intentionally denser than the source and presents the detail surface above the fixed filter instead of below it.

## Focused region comparison evidence

- Typography and controls remain legible at 390 x 844.
- Selected, water, toilet, and current-location markers are visually distinct.
- The detail panel and filter remain usable without covering one another.
- The generated source contains additional detail rows and a roomier sheet; this is a visual-content difference, not a functional blocker.

## Findings

- [P2] The implemented detail panel is more compact than the selected source visual.
  - Location: selected-place detail state.
  - Evidence: the source includes address, kind, coordinates, and source rows; the implementation shows availability, wheelchair status, and OSM ID.
  - Impact: lower fidelity to the source, but the available live OSM metadata remains actionable.

## Primary interactions tested

Passed: spot detail, all three filters, detail dismissal when its kind is filtered out, current-location behavior, initial loading when the Geolocation API is unavailable, and full-visible-bounds loading through the OSM fallback.

## Console errors checked

Passed with no browser console or uncaught page errors in the deterministic QA run.

## Comparison history

- Initial mobile-runtime preview exposed the app in a phone frame on desktop.
- User requested a normal responsive web app.
- The phone runtime wrapper was removed; the app now fills the browser viewport on desktop and mobile.
- A development-only stale geolocation callback was found and fixed.
- Post-fix TypeScript build, Vite production build, runtime integrity check, and Sites worker test passed.

## Verification result

- Mobile runtime integrity: passed (28 protected files).
- Production build: passed.
- Sites worker tests: passed (4 tests).
- Mobile runtime browser tests: passed (8 tests).
- App-specific browser QA: passed with deterministic Overpass fixtures.

final result: functional pass; one non-blocking visual-fidelity difference recorded above
