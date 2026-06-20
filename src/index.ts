// Placeholder plugin entry point.
//
// This file is intentionally minimal — the real Plugin function (registering
// the 5 foundational tools ghs-init / ghs-status / ghs-archive / ghs-force-archive
// / ghs-config plus the experimental.chat.system.transform hook) lands in
// s1-feat-011. It exists now so that:
//   1. `package.json`'s `main: "src/index.ts"` resolves to a real file.
//   2. `tsc --noEmit` finds at least one input and exits cleanly.
//
// Do NOT add tool registrations or hook logic here until s1-feat-011.

export default undefined;
