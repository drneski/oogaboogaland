import { createHash } from "node:crypto";
import { declaredIdentity } from "./character-identity.mjs";
import { BOT, isOperator } from "./character-operators.mjs";
import { CharacterRejection, characterPath, touchesCharacters, scanCharacter, checkOwner, safeCharacterSource } from "./character-safety.mjs";

export const LANES = ["daily", "manual"];
export const manifestPath = (lane) => `.github/character-bundles/${lane}.json`;
export const branchPrefix = (lane) => `automation/characters-${lane}-`;
export const digest = (source) => createHash("sha256").update(source).digest("hex");
export const dayOf = (date = new Date()) => date.toISOString().slice(0, 10);
export const due = (state, now = new Date()) => state.lane === "daily" && state.entries.length > 0 && state.openedOn < dayOf(now);
const reject = (reason) => { throw new CharacterRejection(reason); };
export const isMaintainer = async (gh, login) => {
  const permission = await gh.api(`collaborators/${encodeURIComponent(login)}/permission`, "GET", undefined, true);
  return permission?.permission === "admin" || permission?.role_name === "maintain";
};
const regular = (file) => {
  if (!characterPath(file.filename) || !["added", "modified"].includes(file.status) || file.previous_filename) reject("Character deletion, rename or irregular path requires separate maintainer review.");
};

// Examine every character revision in the submission, not only its final diff.
// GitHub's authenticated PR author is the ownership authority; commit email is not.
export const inspectSubmission = async (gh, submission, rock) => {
  const pr = submission.pr ? await gh.api(`pulls/${submission.pr}`) : null;
  if (pr && (pr.base.ref !== "rock" || pr.head.sha !== submission.head && !submission.archived)) throw new Error("Submission changed; retry its latest head");
  const commit = pr ? null : await gh.api(`commits/${submission.head}`);
  const author = pr ? pr.user.login : commit.author?.login;
  const comparison = await gh.api(`compare/${rock}...${submission.head}`);
  if (!comparison.merge_base_commit?.sha) throw new Error("Cannot establish submission base");
  // Compare's files are capped at 300. Refuse the boundary rather than lose files.
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) throw new Error("Submission diff too large for safe extraction");
  const changed = comparison.files.filter(touchesCharacters);
  if (!changed.length) return { entries: [], hasCharacters: false, mixed: comparison.files.length > 0, author };
  if (!author || (!pr && (!commit.commit.verification?.verified || commit.committer?.login !== author))) reject("Standalone commits need a verified signature with the same linked GitHub author and committer; otherwise submit an authenticated PR.");
  const maintainer = await isMaintainer(gh, author);
  if (changed.length > 16) reject("At most 16 character files may be submitted together.");
  for (const file of changed) regular(file);
  if (pr && submission.archived && pr.head.sha !== submission.head) {
    const current = await gh.api(`compare/${rock}...${pr.head.sha}`);
    if (!current.files || current.files.length >= 300 || current.files.some(touchesCharacters)) throw new Error("Source PR has newer character edits; requeue before merging its old version");
  }
  const commits = pr && !submission.archived ? await gh.list(`pulls/${pr.number}/commits`, 1) : comparison.commits;
  if (!Array.isArray(commits) || commits.length > 100 || comparison.total_commits > 100) throw new Error("Submission history too large for safe extraction");
  const lanes = new Map(), touched = new Set();
  for (const item of commits) {
    // Only commits actually in the pinned source head. On archived source PRs,
    // later edits must never replace the reviewed immutable source revision.
    if (pr && submission.archived && pr.head.sha !== submission.head && item === commits[0]) {
      const ancestry = await gh.api(`compare/${submission.head}...${pr.head.sha}`);
      if (!["ahead", "identical"].includes(ancestry.status)) throw new Error("Source PR history was replaced; requeue its current version");
    }
    const revision = await gh.api(`commits/${item.sha}?per_page=100`);
    if (!revision.files || revision.files.length >= 100) throw new Error("Commit file list may be truncated; review manually");
    const files = revision.files.filter(touchesCharacters);
    if (!files.length) continue;
    const committer = revision.author?.login;
    if (!committer || committer.toLowerCase() !== author.toLowerCase() && !await isMaintainer(gh, committer)) reject("A character-changing commit is attributed to another GitHub user or an unresolved author.");
    for (const file of files) {
      regular(file);
      const blob = await gh.file(item.sha, file.filename);
      if (!blob) reject("Character revision is missing.");
      const scanned = scanCharacter(blob.source);
      const previous = revision.parents?.[0] ? await gh.file(revision.parents[0].sha, file.filename) : null;
      checkOwner(scanned.row, previous ? declaredIdentity(previous.source) : null, author, maintainer);
      if (scanned.lane === "manual") lanes.set(file.filename, "manual");
      touched.add(file.filename);
    }
  }
  const entries = [];
  for (const file of changed) {
    if (!touched.has(file.filename)) reject("Cannot attribute the character change to a submitted commit.");
    const original = await gh.file(submission.head, file.filename), scanned = scanCharacter(original.source);
    const base = await gh.file(comparison.merge_base_commit.sha, file.filename);
    checkOwner(scanned.row, base ? declaredIdentity(base.source) : null, author, maintainer);
    const current = await gh.file(rock, file.filename);
    const lane = lanes.get(file.filename) || scanned.lane;
    // Manual code must already declare its alias; never rewrite unparsed code.
    const literal = declaredIdentity(original.source);
    if (lane === "manual" && (scanned.row.github || scanned.row.handle).toLowerCase() !== (literal.github || literal.handle).toLowerCase()) reject("Custom character code must explicitly declare its owning github login.");
    const source = lane === "daily" ? safeCharacterSource(scanned.row) : original.source;
    // A previously merged identical contribution is a no-op, not a new bundle item.
    if (current?.source === source) continue;
    if ((current?.sha || null) !== (base?.sha || null)) throw new Error("Character changed on rock since this submission; rebase before extraction");
    entries.push({ pr: pr?.number || null, head: submission.head, author, path: file.filename,
      base: current?.sha || null, hash: digest(source), lane, source });
  }
  return { entries, hasCharacters: true, mixed: comparison.files.some((file) => !touchesCharacters(file)), author };
};

export const readManifest = (source, lane) => {
  let state;
  try { state = JSON.parse(source); } catch { throw new Error("Invalid bundle manifest JSON"); }
  if (state?.version !== 1 || state.lane !== lane || !/^\d{4}-\d{2}-\d{2}$/.test(state.openedOn)
    || !Array.isArray(state.entries) || state.entries.length > 128) throw new Error("Invalid bundle manifest");
  const paths = new Set();
  for (const entry of state.entries) {
    if (!characterPath(entry.path) || paths.has(entry.path) || entry.lane !== lane || !/^[a-f0-9]{40}$/.test(entry.head)
      || entry.base !== null && !/^[a-f0-9]{40}$/.test(entry.base) || !/^[a-f0-9]{64}$/.test(entry.hash)
      || entry.pr !== null && (!Number.isSafeInteger(entry.pr) || entry.pr <= 0)) throw new Error("Invalid bundle provenance");
    paths.add(entry.path);
  }
  return state;
};

export const checkRegistry = async (gh, rock, entries) => {
  const rows = new Map(), owners = new Map();
  for (const [path] of await gh.tree(rock)) if (characterPath(path)) rows.set(path, declaredIdentity((await gh.file(rock, path)).source));
  for (const entry of entries) rows.set(entry.path, declaredIdentity(entry.source));
  if (rows.size > 128) reject("Character capacity exceeded.");
  for (const [path, row] of rows) for (const name of new Set([row.handle, row.github].filter(Boolean).map((key) => key.toLowerCase()))) {
    if (owners.has(name)) reject("A handle or GitHub owner already has a different character file.");
    owners.set(name, path);
  }
};

// The initial empty PRs were opened by Actions; a configured App can adopt them.
// The current head must still be a verified commit by the configured bot.
export const isBundle = (pr, bot) => bot && [bot, BOT].includes(pr.user.login) && pr.head.repo?.full_name === pr.base.repo.full_name
  && LANES.some((lane) => pr.head.ref.startsWith(branchPrefix(lane)));

// Reserve queued identities for onboarding without executing their custom code.
// Full merge validation stays separate: an untouched generated default on rock
// may already conflict with a queued addition and need onboarding to remove it.
export const queuedCharacters = async (gh, bot) => {
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(bot || "")) throw new Error("Missing trusted character bot login");
  const queued = [];
  for (const listed of await gh.list("pulls?state=open&base=rock")) {
    if (!isBundle(listed, bot)) continue;
    const pr = await gh.api(`pulls/${listed.number}`);
    if (pr.state !== "open") continue;
    if (!isBundle(pr, bot) || pr.base.ref !== "rock") throw new Error("Untrusted bundle identity");
    const lane = LANES.find((value) => pr.head.ref.startsWith(branchPrefix(value)));
    const head = await gh.api(`commits/${pr.head.sha}`);
    if (head.author?.login !== bot || !head.commit.verification?.verified) throw new Error("Bundle head is not a verified commit by the trusted automation");
    const manifest = await gh.file(pr.head.sha, manifestPath(lane), 262144);
    if (!manifest) throw new Error("Bundle provenance is missing");
    for (const entry of readManifest(manifest.source, lane).entries) {
      const file = await gh.file(pr.head.sha, entry.path);
      if (!file || digest(file.source) !== entry.hash) throw new Error("Bundled file differs from the scanned source");
      queued.push({ path: entry.path, base: entry.base, character: declaredIdentity(file.source) });
    }
  }
  return queued;
};

export const reviewDecision = async (gh, pr) => {
  const latest = new Map();
  for (const review of await gh.list(`pulls/${pr.number}/reviews`)) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.login, review);
  }
  let approved = false, changesRequested = false;
  for (const [login, review] of latest) if (login !== pr.user.login && isOperator(review.user) && await isMaintainer(gh, login)) {
    if (review.state === "CHANGES_REQUESTED") changesRequested = true;
    if (review.state === "APPROVED" && review.commit_id === pr.head.sha) approved = true;
  }
  return { approved: approved && !changesRequested, changesRequested };
};

export const validateBundle = async (gh, pr, bot, rock) => {
  if (!isBundle(pr, bot) || pr.base.ref !== "rock") throw new Error("Untrusted bundle identity");
  const lane = LANES.find((value) => pr.head.ref.startsWith(branchPrefix(value)));
  const manifest = await gh.file(pr.head.sha, manifestPath(lane), 262144);
  if (!manifest) throw new Error("Bundle provenance is missing");
  const state = readManifest(manifest.source, lane), entries = [];
  const head = await gh.api(`commits/${pr.head.sha}`);
  if (head.author?.login !== bot || !head.commit.verification?.verified) throw new Error("Bundle head is not a verified commit by the trusted automation");
  const groups = new Map();
  for (const entry of state.entries) {
    const key = `${entry.pr}:${entry.head}`;
    if (!groups.has(key)) groups.set(key, await inspectSubmission(gh, { pr: entry.pr, head: entry.head, archived: true }, rock));
    const verified = groups.get(key).entries.find((row) => row.path === entry.path && row.lane === lane && row.hash === entry.hash && row.base === entry.base && row.author === entry.author);
    if (!verified) throw new Error("Bundle entry no longer matches its verified source");
    const file = await gh.file(pr.head.sha, entry.path);
    if (!file || digest(file.source) !== verified.hash) throw new Error("Bundled file differs from the scanned source");
    entries.push(verified);
  }
  const diff = await gh.api(`compare/${rock}...${pr.head.sha}`);
  if (!diff.files || diff.files.length >= 300) throw new Error("Bundle diff is incomplete");
  const allowed = new Set([manifestPath(lane), ...entries.map((entry) => entry.path)]);
  if (diff.files.some((file) => !allowed.has(file.filename) || !["added", "modified"].includes(file.status) || file.previous_filename)) throw new Error("Bundle contains unexpected files");
  for (const entry of entries) if (!diff.files.some((file) => file.filename === entry.path)) throw new Error("Bundle contains a no-op entry; reconcile before merging");
  await checkRegistry(gh, rock, entries);
  return { state, entries, lane };
};
