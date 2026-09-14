# Treno iOS redesign

The iOS app is organized around the passenger's next action: find a station,
check a departure, or follow a saved journey. It uses three native tabs:
Home, Stations, and Journeys. Settings is available from Home.

## Design

- Semantic system surfaces, adaptive light/dark appearance, SF Symbols, and
  Dynamic Type styles across the main screens.
- Native navigation and tab materials; solid content cards with consistent
  spacing and corner radii. Blue for actions, separate colors for train status.
- Labeled departure, arrival, and platform information; optional timing
  explanations under “About these times.”
- Station search, favorites, map browsing, saved routes, editing, and Live
  Activities remain connected to the existing API and local saved data.
- Loading, unavailable, and empty states have distinct messages. New installs
  start with an invitation to save a route rather than an invented commute.

The navigation/content separation follows Apple's
[materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials).

## Verification

Built and launched both the app and its widget extension with XcodeBuildMCP
on iPhone 17 Pro / iOS 26.5. Final build: zero warnings or errors.
Backend `npm run typecheck` and `git diff --check` passed.

Manually exercised Today → journey → train, the Stations tab, station search
for Monza, station selection in the new-journey form, same-origin/destination
validation, switching Light/Dark appearance, and starting/stopping a Live
Activity. Screenshots in `preview/redesign/` show actual API data.

The pass also corrects premature “now” labels for trains running elsewhere,
intermediate-journey arrival times incorrectly taken from the end of the full
train route, station-response races, and asynchronous Live Activity stop/start
ordering. Transfer minimums are labeled as minimums.

Physical-device behavior, every Dynamic Type size, and home-screen widget
layouts were not visually tested. Live Activity refresh still depends on the
existing in-app update loop; background push updates are outside this change.

## Liquid Glass and personalization refinement

Home now opens with “For you,” the next saved route, and only favorite or
recently used stations. The calendar date, generic station suggestions,
repeated helper copy, and home-screen train numbers have been removed.
Custom journey names appear on their cards. Departure, arrival, delay,
and platform information remain explicit.

Search, add-journey, station selection, map controls, and following actions
use native Liquid Glass. Related controls use GlassEffectContainer, with
soft background color giving the material depth. Timetables stay on opaque
content surfaces. Custom glass and background effects fall back to solid
system surfaces for Reduce Transparency or Increase Contrast.
