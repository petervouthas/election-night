# Sources for districts.json / hexmap.json (built 2026-11-02)

## districts.json (120th Congress maps, used for the Nov 3, 2026 election)
All 50 states: U.S. Census Bureau TIGER/Line 2026, 120th Congressional Districts, state-based files
(vintage dated 2026-09/10, CDSESSN=120):
  https://www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_<FIPS>_cd120.zip   (FIPS 01..56, 50 states; DC/territories omitted)
Clipped to land with Census cartographic boundary states (to remove TIGER's coastal/Great Lakes water areas):
  https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_5m.zip
Features with CD120FP = "ZZ" (unassigned water) dropped. At-large "00" -> district 1.
Processing: mapshaper -clip ... -simplify 7% weighted keep-shapes -filter-slivers; TopoJSON quantization 1e5.

Mid-decade redraws: determined by comparing TIGER 2026 cd120 vs TIGER 2025 cd119
(https://www2.census.gov/geo/tiger/TIGER2025/CD/tl_2025_<FIPS>_cd119.zip) district land areas.
States whose districts changed: AL, CA, FL, LA, MO, NC, OH, TN, TX, UT (10 states).
All other states, incl. VA (2026 referendum map struck down by VA Supreme Court), are identical to the 119th map.
Cross-check: Ballotpedia https://news.ballotpedia.org/2026/05/11/new-congressional-maps-in-florida-tennessee-aim-to-shift-five-more-districts-to-republicans-ahead-of-2026-midterms/
and Scripps https://www.scrippsnews.com/politics/congress/rapid-redistricting-reshapes-us-political-map-ahead-of-2026-midterms

## hexmap.json (rebuilt 2026-11-03: square-tile cartogram)
One square per House seat (435). Each state is a block of squares whose proportions roughly follow the state, placed by
hand on a grid in the familiar state-tile arrangement with one-cell gutters (the New York Times election cartogram style).
The order of districts inside a block follows the relative positions of The Downballot's Congressional District Hexmap
v3.2 (Daniel Donner, CC BY 4.0, https://the-db.co/maps; HexCDv32 shapefile, 2026 district lines), matched by a
minimum-distance assignment. Format: {type:"HexBundle", shape:"square", hex: FeatureCollection, states: FeatureCollection}
(planar grid units, y down; state outlines are the merged block edges). Builder: scratch tool `sqblobs.js` (hand layout table
`LAYOUT` = [x, y, width] per state).
