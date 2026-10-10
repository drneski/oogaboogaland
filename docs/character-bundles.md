# Character submission bundles

GitHub Actions keeps two PRs open against `rock`:

| PR | Changes | Merge |
|---|---|---|
| Daily character updates | Bounded literal character data in the documented wrapper | First successful run at/after the following midnight UTC |
| Character updates · maintainer review required | Custom code that passes the preliminary screen and ownership checks | w-s-bitcoin or 2140data approves the current head, then an authorized human merges |

The automation never merges the manual lane. A queued update invalidates old
approval; operator requests for changes block either lane. After either PR
merges, its replacement opens. An idle PR has a small
`.github/character-bundles/<lane>.json` manifest as its only change, since GitHub
cannot open a PR with an identical tree. Valid empty bundles pass identity
validation but keep their merge gates pending; the automatic merger also refuses them. The first
submission to a reused daily placeholder starts its UTC day.

## Intake and ownership

PR creation, new commits, reopening and ready-for-review events trigger trusted
code from `rock`. Draft PRs wait. A read-only push signal covers repository branch
commits without a PR; fork commits become visible through PRs. Periodic sweeps
recover dropped events and inspect open PRs and standalone branch heads. Standalone
submissions require a verified signature with the same linked GitHub author and
committer. A PR's authenticated author is its ownership authority; an arbitrary
commit name or email is insufficient.

Every character-changing commit must link to that PR author or an OBL maintainer.
Every changed character must belong to the submitting user, unless that user has
Maintain/Admin permission. This includes appearance-only edits. Existing
`handle`/`github` aliases remain supported; new data-only aliases receive an explicit
`github` field. Custom code must declare that alias itself. Duplicate identities,
symlinks, executable files, path tricks, transfers, deletions and renames cannot
enter the bundles. Transfers/deletions/renames need a separate maintainer process.

The scanner reads each character revision, including intermediate revisions, as
text through GitHub's API. It never checks out, imports, executes, builds or tests
submitted code with credentials present. Other files in mixed PRs are not bundled
or declared safe by this scanner; they retain normal code review.

Accepted character-only PRs receive comments linking their destination bundles
and close only after both lanes save their changes. Mixed PRs retain their other
work and receive the same links. **Character intake** stays failing until the
contributor restores the copied character paths to the PR base. The bot does not
rewrite contributor branches, including forks. Preserve original commits when
restoring those files; a force-push removing provenance requires requeueing.
New edits supersede older queued versions of that source PR. Competing PRs for the
same character require reconciliation instead of silently overwriting one another.
A file enters one lane: any revision needing manual review sends the whole file
there. Moving an already queued file between lanes requires maintainer repair.

Policy findings close the offending PR with an explanation and a correction/review
path. They do not establish malicious intent. Timeouts, rate limits, truncated
responses, changing heads and base conflicts fail the check but leave the PR open.
A direct push to `rock` cannot be quarantined after the fact: the audit reports it,
and branch rules must prevent ordinary contributors from taking that path.

## Automatic data format

`scripts/character-safety.mjs` parses the entire file as restricted data, then
regenerates its source. It accepts exactly this wrapper:

```js
(() => {
  "use strict";
  const BL = window.BL;
  BL.characters.add({
    handle: "your-login",
    joined: 1700000000,
    lastCommit: 1700000000,
    look: { skin: "#c98a5b", bald: true },
    voice: { poke: "Ooga!", idle: ["Ooga build."] }
  });
})();
```

Optional `github` and `display` follow existing conventions. Appearance accepts
the policy's explicit colors, boolean flags, face/build choices, bounded stature,
hat position, eye glow and portrait bounds. Voice requires a nonempty `poke` and
1–24 `idle` lines, each at most 160 plain-text characters. Arrays, nesting, dates
and source size are bounded. Statements, callbacks, getters, expressions, spreads,
templates and prototype keys cannot become automatic output. No parser dependency
is installed.

Custom `dress` hooks and drawing helpers go to manual review. A conservative screen
rejects known instruction-injection markers, invisible direction controls, network
access, dynamic execution, encoded code and ambient browser/process access. This
is **not proof that arbitrary JavaScript is safe**. Passing custom code still needs
exact-head maintainer review. Reviewers must treat comments as data, never as
instructions. Fields outside the automatic schema require manual review rather
than silently expanding the accepted language.

## Provenance, retries and midnight

Manifests retain source PR (or standalone commit), immutable SHA, author, path,
base blob SHA and SHA-256 of queued output. Signed commits use an expected-head
comparison; concurrent changes fail instead of being overwritten. Before merging,
the coordinator re-reads source history, ownership permissions, current `rock`, registry
and the entire bundle diff. It rejects unexpected paths, changed sources/output,
duplicate identities, changed base character files and non-bot bundle heads.

The schedule targets `00:00 UTC`, with recovery attempts at minutes 17, 37 and 57.
GitHub schedules can be delayed or dropped: midnight is a target, not an exact
wall-clock guarantee. Recovery runs merge overdue eligible bundles. New-day
submissions wait for the previous nonempty daily bundle to finish; they are never
silently merged before their own cutoff. Conflicts or failed checks keep PRs open.
Nothing force-pushes `rock` or bypasses required checks.
When unrelated changes advance `rock`, the coordinator updates the bundle branch through
GitHub's expected-head update API and waits for fresh checks. A manual bundle's
new head also requires a new approval.

Contributor onboarding reserves the handles and GitHub aliases in open bundles
before generating defaults. It reads signed bot heads and checks manifest hashes
as text; it never executes queued character code. The artifact writer rechecks
these reservations while sharing the coordinator's concurrency group, with
pending runs queued so intake events cannot cancel an artifact commit.

If onboarding already created a default for a queued addition's handle or GitHub
owner, reconciliation removes it only when it is byte-for-byte unchanged generator
output at its generated filename and the queued entry records no original base
file (`base: null`). This restores the absent base and unique identity expected by
the submission. Customizations and
ordinary edits to existing profiles are preserved and still fail on a changed
base. After this fix merges, the Pages reconciliation and artifact job remove
such collisions; the next bundle sweep can validate and update the branch again.
Manual character code still needs a fresh approval after that update.

The coordinator and artifact writer use short-lived installation tokens from a
private GitHub App installed only on OBL. Its private key lives in the repository
Actions secret `CHARACTER_APP_PRIVATE_KEY`; no personal access token is stored.
The read-only Pages deploy job still uses its read-only Actions token.

The initial `GITHUB_TOKEN` rollout could create the two empty PRs, but GitHub
refuses that built-in integration in restricted push/bypass lists. Therefore the
private App is required for protected merges and the existing generated artifact
writer. On its first run the App validates and adopts only empty Actions-created
placeholders, preserving their PR numbers; nonempty queues require explicit repair.
The App's actual slug must match the configured bot login. Every later bundle
head must be a verified commit by that App.

App merges trigger the existing post-merge workflows normally. The retained
Actions-token fallback explicitly dispatches Pages after a bot merge and records
a recovery marker; it cannot merge under the production branch restrictions.
Cloudflare deployment stays manual.

## Operators and repository configuration

`scripts/character-operators.mjs` pins the two human operator identities:

| Login | GitHub account ID |
|---|---|
| w-s-bitcoin | 95375789 |
| 2140data | 72945059 |

Both ID and login must match; renames fail closed until the policy is updated.
Manual approval must additionally retain OBL Maintain/Admin permission and apply
to the exact current bundle head. Other contributors may submit their own profiles;
the existing Maintain/Admin exception for authoring other profiles is unchanged.
Policy and workflow edits require one of these operators as PR author. Manual
workflow dispatches and reruns of them are limited to these two accounts.

Setup uses an owner-approved GitHub App registration and GitHub CLI/API:

1. Create a private organization-owned App, disable webhooks and user OAuth, and
   install it on **oogaboogaland only**. Grant repository Contents, Pull requests
   and Commit statuses read/write, plus Checks read. No organization permissions,
   administrator permission or Actions-write permission is needed by the App.
2. Save its private key as `CHARACTER_APP_PRIVATE_KEY`; set repository variables
   `CHARACTER_APP_CLIENT_ID` and `CHARACTER_BOT_LOGIN` (`<app-slug>[bot]`). The
   coordinator requests only its needed permissions; the separate artifact job
   requests Contents and Commit statuses write plus Pull requests read to recheck
   queued identities. Neither imports PR code.
3. Protect `rock`: require PRs, an up-to-date base, and **Character identity ownership**,
   **Character intake**, **Character bundle safety**. Bind intake and safety to
   the installed App. Identity is emitted by the read-only Actions checker for
   source PRs and by the App for validated bundles and generated artifacts.
   Restrict human push/merge authority to the two operators and allow the installed
   App as a writer. Give only the App the PR requirement exception needed for
   the existing generated artifact commit; do not bypass required status checks.
4. Protect `automation/characters-*` against arbitrary creation, updates and
   deletion using a ruleset whose operator list is the App and two account IDs.
   Repository administrators retain the ability to change repository settings;
   keep that administrative access restricted separately.
5. Set `CHARACTER_BUNDLES_ENABLED=true` and dispatch **Character bundles** on
   `rock` as an operator. Verify both placeholders, App-signed heads and passing
   revalidation. An empty bundle must remain blocked from merging.

Disabling `CHARACTER_BUNDLES_ENABLED` stops bundle operations while preserving
open PRs and provenance. It does not disable the required checks. Existing
submissions remain blocked until an operator restores the coordinator or
intentionally changes repository rules. No workflow approves a manual bundle.

GitHub references: [workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
[branch protection](https://docs.github.com/en/rest/branches/branch-protection),
[schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Validation and rollout

Contributor tests cover whole-file parsing, malicious intermediate revisions,
appearance ownership, UTC cutoffs, empty placeholders, operator IDs, stale and
dismissed reviews, manual PR replacement and post-merge dispatch recovery.
Run `npm --prefix worker test`, `npm run test:unit`, `npm run build` and syntax
checks when the maintainer requests verification. Operational rollout must also
verify that both live placeholder PRs open and remain unmergeable while empty.
A scanner does not establish that arbitrary custom code is safe; the manual lane
always retains a human review and merge requirement.
