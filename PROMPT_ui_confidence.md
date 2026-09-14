# Prompt — surface prediction confidence in the Treno iOS app

You are working on the SwiftUI app at `apps/ios/Treno` (iOS 26, dark zinc + Trenord green `#00B566`, flat chrome — `toolbarBackground(tBg)` everywhere, no Liquid Glass except interactive controls; NO info labels — content speaks, colors carry meaning, schedule times strike through under live estimates; never show source names/ids/telemetry).

The prediction engine now outputs calibrated uncertainty (`p10–p90` conformal bands, ~90% coverage, model `heuristic-v1+residual-v1`). The UI hides this. Make the intelligence visible, without clutter:

1. **TripCard (HomeView.swift)**: under the dep→arr times, add a whisper-thin horizontal band visualization (2pt tall capsule track, green fill spanning p10→p90 around p50) — only when `state.ourEstimate` exists.
2. **TrainDetailView estimateCard**: show "ours 21:49 · Trenord 21:52 · likely 21:42–22:04" as a single quiet line under the big times (the refactored file already has this pattern — extend, don't redesign).
3. **TripDetail journey rows**: when our p50 differs from schedule by ≥2 min, the right-side arrival already goes green — add a subtle ±Xm range only on the highlighted next journey.
4. **Dynamic Island expanded (Widget/TrenoWidgetBundle.swift)**: under the progress bar, add `likely HH:MM–HH:MM` in 9pt dim when ContentState carries it (add `likely10/likely90` fields to TripActivityAttributes.ContentState — shared file compiles in both targets, keep it dependency-free; LiveTracker.swift builds ContentState.from(JourneyRow), pass ourP10/ourP90).

Data: `JourneyRow.state.ourEstimate` has `p10/p50/p90/confidence/modelVersion`. Verify with `xcrun simctl launch "iPhone 17 Pro" com.treno.Treno --open-trip` / `--train <id>` deep links, screenshot (`xcrun simctl io "iPhone 17 Pro" screenshot`), compress to jpg, and visually inspect before committing. Design system tokens are in Theme.swift. Commit with a descriptive message.
