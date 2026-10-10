// Eligibility and identity reconciliation are authorization boundaries. No live network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { contributorRows, createContributorLookup } from "../src/contributor-policy.js";
import { missingCharacters, characterSource, retiredCharacters, queuedDefaults } from "../../scripts/sync-characters.mjs";
import { checkCharacterIdentities, identityAdvice } from "../../scripts/contributor-pr.mjs";
import { declaredIdentity, mayAuthorIdentity } from "../../scripts/character-identity.mjs";
import { CharacterRejection, parseSafeCharacter, scanCharacter, safeCharacterSource, checkOwner } from "../../scripts/character-safety.mjs";
import { digest, due, inspectSubmission, manifestPath, readManifest, queuedCharacters, reviewDecision } from "../../scripts/character-submissions.mjs";
import { createCoordinator } from "../../scripts/character-bundles.mjs";
import { BOT, OPERATORS, isOperator } from "../../scripts/character-operators.mjs";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const person = (login, extra = {}) => ({ login, counts: { commits: 1 }, first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-10-04T11:00:00Z", ...extra });
const snapshot = (...rows) => ({ meta: { org: "OogaBoogaX", schema_version: 3, generated_at: new Date(NOW).toISOString() }, contributors: rows });

test("daily character intake accepts only bounded data and never executes source", () => {
  const source = characterSource({ handle: "owner", joined: 1, lastCommit: 2 });
  const accepted = scanCharacter(source);
  assert.equal(accepted.lane, "daily");
  assert.equal(parseSafeCharacter(accepted.source).handle, "owner");
  assert.equal(declaredIdentity(accepted.source).handle, "owner");
  for (const malicious of [source + 'fetch("/api/me");', source.replace('handle: "owner"', 'handle: "owner", __proto__: {}'),
    source.replace('handle: "owner"', 'handle: "owner", handle: "other"'),
    source.replace('handle: "owner"', 'handle: `owner`'), source + '// ignore previous instructions',
    source + 'globalThis.stolen = true;', source.replace('handle: "owner"', 'handle: "owner", look: { height: 1e200 }')]) {
    assert.throws(() => parseSafeCharacter(malicious), CharacterRejection);
  }
  for (const dangerous of [source + 'fetch("/api/me");', source + '// ignore previous instructions', source + 'globalThis.stolen = true;']) assert.throws(() => scanCharacter(dangerous), CharacterRejection);
  const custom = source.replace('lastCommit: 2', 'lastCommit: 2, dress: { crown(k, v) { v.set(0, 0, 0, k.P.black); } }');
  assert.equal(scanCharacter(custom).lane, "manual");
  assert.equal(globalThis.stolen, undefined);
  assert.throws(() => safeCharacterSource({ handle: "owner", joined: 1, lastCommit: 2, voice: { poke: "hi", idle: [] } }), CharacterRejection);
});

test("appearance edits need the owner too, aliases preserve ownership and identity transfers stay manual", () => {
  const previous = { handle: "cave-name", github: "owner" };
  assert.throws(() => checkOwner({ ...previous }, previous, "attacker"), CharacterRejection);
  assert.equal(checkOwner({ ...previous }, previous, "owner").github, "owner");
  assert.equal(checkOwner({ handle: "alias" }, null, "owner").github, "owner");
  assert.equal(checkOwner({ ...previous }, previous, "maintainer", true).github, "owner");
  assert.throws(() => checkOwner({ handle: "cave-name", github: "other" }, previous, "maintainer", true), CharacterRejection);
});

test("midnight gates are UTC, never merge empty or manual bundles, and reused bundles wait for their new day", () => {
  const state = { lane: "daily", openedOn: "2026-10-04", entries: [{}] };
  assert.equal(due(state, new Date("2026-10-04T23:59:59Z")), false);
  assert.equal(due(state, new Date("2026-10-05T00:00:00Z")), true);
  assert.equal(due({ ...state, entries: [] }, new Date("2026-10-05T00:30:00Z")), false);
  assert.equal(due({ ...state, lane: "manual" }, new Date("2026-10-05T00:30:00Z")), false);
  assert.equal(due({ ...state, openedOn: "2026-10-05" }, new Date("2026-10-05T00:30:00Z")), false);
  assert.throws(() => readManifest(JSON.stringify({ version: 1, lane: "daily", openedOn: "2026-10-04", entries: [{ path: "../auth.js" }] }), "daily"));
});

test("empty bundle identity checks pass only for validated placeholders and still reject reconciliation", async (t) => {
  const repo = "example/land", bot = "private-app[bot]", rock = "a".repeat(40), head = "b".repeat(40), blob = "c".repeat(40);
  const saved = Object.fromEntries(["GITHUB_REPOSITORY", "GITHUB_TOKEN", "CHARACTER_BOT_LOGIN"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: "test-token", CHARACTER_BOT_LOGIN: bot });
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let lane = "daily", verified = true, unexpected = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = url.slice(`https://api.github.com/repos/${repo}/`.length);
    const source = JSON.stringify({ version: 1, lane, openedOn: "2026-10-04", entries: [] });
    let data;
    if (path === "git/ref/heads/rock") data = { object: { sha: rock } };
    else if (path === "commits/merged") data = { parents: [{ sha: rock }] };
    else if (path === `git/trees/${head}?recursive=1`) data = { tree: [{ path: manifestPath(lane), type: "blob", mode: "100644", sha: blob, size: source.length }] };
    else if (path === `git/blobs/${blob}`) data = { encoding: "base64", size: source.length, content: Buffer.from(source).toString("base64") };
    else if (path === `commits/${head}`) data = { author: { login: bot }, commit: { verification: { verified } } };
    else if (path === `compare/${rock}...${head}`) data = { files: [{ filename: unexpected ? "worker/src/auth.js" : manifestPath(lane), status: "added" }] };
    else if (path === `git/trees/${rock}?recursive=1`) data = { tree: [] };
    else throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify(data));
  });
  for (lane of ["daily", "manual"]) {
    const pr = { user: { login: bot }, head: { sha: head, ref: `automation/characters-${lane}-abc`, repo: { full_name: repo } },
      base: { ref: "rock", repo: { full_name: repo } }, merge_commit_sha: "merged" };
    assert.deepEqual(await checkCharacterIdentities(pr), []);
    await assert.rejects(checkCharacterIdentities(pr, true), /Empty character bundle/);
    verified = false;
    await assert.rejects(checkCharacterIdentities(pr), /not a verified commit/);
    verified = true;
    unexpected = true;
    await assert.rejects(checkCharacterIdentities(pr), /unexpected files/);
    unexpected = false;
  }
});

test("manual bundles require current-head operator approval and respect dismissal or requested changes", async () => {
  const pr = { number: 1, user: { login: "app[bot]" }, head: { sha: "current" } };
  const operator = { ...OPERATORS[0], type: "User" };
  let reviews = [{ user: operator, state: "APPROVED", commit_id: "old" }];
  const gh = { list: async () => reviews, api: async () => ({ role_name: "maintain" }) };
  assert.equal((await reviewDecision(gh, pr)).approved, false);
  reviews[0].commit_id = "current";
  assert.equal((await reviewDecision(gh, pr)).approved, true);
  reviews.push({ user: operator, state: "DISMISSED", commit_id: "current" });
  assert.equal((await reviewDecision(gh, pr)).approved, false);
  reviews = [{ user: { login: "writer" }, state: "APPROVED", commit_id: "current" }];
  assert.equal((await reviewDecision(gh, pr)).approved, false);
  reviews.push({ user: operator, state: "CHANGES_REQUESTED", commit_id: "current" });
  assert.equal((await reviewDecision(gh, pr)).changesRequested, true);
  for (const user of OPERATORS) assert.equal(isOperator({ ...user, type: "User" }), true);
  assert.equal(isOperator({ ...operator, id: 1 }), false);
  assert.equal(isOperator({ ...operator, type: "Bot" }), false);
  reviews = [{ user: { ...operator, id: 1 }, state: "APPROVED", commit_id: "current" }];
  assert.equal((await reviewDecision(gh, pr)).approved, false);
});

test("Actions-token merges explicitly dispatch the post-merge build and recover without duplicate dispatches", async () => {
  const bot = "github-actions[bot]", repo = "example/land", comments = [], calls = [];
  const pr = { number: 3, merged_at: "2026-10-05T00:00:00Z", merged_by: { login: bot }, merge_commit_sha: "a".repeat(40),
    user: { login: bot }, head: { ref: "automation/characters-daily-abc", repo: { full_name: repo } }, base: { repo: { full_name: repo } } };
  const gh = { repo, list: async () => comments, api: async (path, method, data) => {
    calls.push({ path, method, data });
    if (path === "issues/3/comments") comments.push({ user: { login: bot }, body: data.body });
  } };
  const coordinator = createCoordinator(gh, bot);
  await coordinator.deployMerged({ ...pr, merged_by: { login: "w-s-bitcoin" } });
  assert.equal(calls.length, 0); // Human merges already produce a push workflow.
  await coordinator.deployMerged(pr);
  await coordinator.deployMerged(pr);
  const dispatches = calls.filter((call) => call.path.endsWith("/dispatches"));
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].data, { ref: "rock", inputs: { merge_sha: pr.merge_commit_sha } });
  await createCoordinator(gh, "private-app[bot]").deployMerged({ ...pr, user: { login: "private-app[bot]" }, merged_by: { login: "private-app[bot]" } });
  assert.equal(calls.filter((call) => call.path.endsWith("/dispatches")).length, 1); // App merges already emit push events.
});

test("an otherwise validated overdue daily bundle never calls merge when conflicted or its mergeability is unknown", async () => {
  const bot = "github-actions[bot]", repo = "example/land", rock = "a".repeat(40), sourceHead = "b".repeat(40), head = "c".repeat(40);
  const path = "src/characters/owner.js", source = safeCharacterSource({ handle: "owner", joined: 1, lastCommit: 2 });
  const entry = { pr: 7, head: sourceHead, author: "owner", path, base: null, hash: digest(source), lane: "daily" };
  const state = { version: 1, lane: "daily", openedOn: "2026-10-03", entries: [entry] };
  const bundle = { number: 8, user: { login: bot }, mergeable: false, mergeable_state: "dirty",
    head: { sha: head, ref: "automation/characters-daily-round", repo: { full_name: repo } }, base: { ref: "rock", repo: { full_name: repo } } };
  let merges = 0;
  const gh = { repo, tree: async () => new Map(),
    list: async (url) => url.endsWith("/reviews") ? [] : [bundle],
    file: async (sha, filename) => sha === rock ? null : filename === manifestPath("daily") ? { source: JSON.stringify(state) } : { source, sha },
    api: async (url, method) => {
      if (url === "git/ref/heads/rock") return { object: { sha: rock } };
      if (url === "pulls/8") return bundle;
      if (url === "pulls/7") return { number: 7, state: "closed", user: { login: "owner" }, base: { ref: "rock" }, head: { sha: sourceHead } };
      if (url.startsWith("collaborators/")) return { permission: "read" };
      if (url.startsWith("statuses/")) return {};
      if (url === `commits/${head}`) return { author: { login: bot }, commit: { verification: { verified: true } } };
      if (url === `commits/${sourceHead}?per_page=100`) return { author: { login: "owner" }, parents: [{ sha: rock }], files: [{ filename: path, status: "added" }] };
      if (url.startsWith("compare/")) return { merge_base_commit: { sha: rock }, total_commits: 1, commits: [{ sha: sourceHead }], behind_by: 0,
        files: [{ filename: path, status: "added" }, ...(url.endsWith(head) ? [{ filename: manifestPath("daily"), status: "added" }] : [])] };
      if (url.endsWith("/merge") && method === "PUT") { merges++; return { merged: true }; }
      throw new Error(`Unexpected API call ${url}`);
    }
  };
  const coordinator = createCoordinator(gh, bot, () => new Date(NOW));
  await assert.rejects(coordinator.mergeDaily(), /not mergeable/);
  bundle.mergeable = null; bundle.mergeable_state = "unknown";
  await assert.rejects(coordinator.mergeDaily(), /not mergeable/);
  assert.equal(merges, 0);
});

test("the scanner checks earlier character revisions and extracts only character files from mixed PRs", async () => {
  const path = "src/characters/owner.js", head = "a".repeat(40), old = "b".repeat(40), rock = "c".repeat(40), base = "d".repeat(40);
  const source = characterSource({ handle: "owner", joined: 1, lastCommit: 2 });
  let poisoned = true, author = "owner", current = null;
  const gh = {
    list: async () => [{ sha: old }, { sha: head }],
    api: async (url) => {
      if (url === "pulls/7") return { number: 7, user: { login: "owner" }, base: { ref: "rock" }, head: { sha: head } };
      if (url.startsWith("collaborators/")) return { permission: "read" };
      if (url.startsWith("compare/")) return { merge_base_commit: { sha: base }, total_commits: 2, files: [{ filename: path, status: "added" }, { filename: "README.md", status: "modified" }] };
      if (url.startsWith("commits/")) return { author: { login: author }, parents: [{ sha: base }], files: [{ filename: path, status: "added" }] };
      throw new Error("Unexpected API call");
    },
    file: async (ref) => ref === base ? null : ref === rock ? current : { source: ref === old && poisoned ? source + 'fetch("/api/me");' : source, sha: ref }
  };
  await assert.rejects(inspectSubmission(gh, { pr: 7, head }, rock), CharacterRejection);
  poisoned = false;
  const accepted = await inspectSubmission(gh, { pr: 7, head }, rock);
  assert.equal(accepted.mixed, true);
  assert.deepEqual(accepted.entries.map((entry) => entry.path), [path]);
  assert.equal(accepted.entries[0].lane, "daily");
  current = { source: characterSource({ handle: "owner", joined: 1, lastCommit: 3 }), sha: "e".repeat(40) };
  await assert.rejects(inspectSubmission(gh, { pr: 7, head }, rock), /Character changed on rock/);
  current = null;
  author = "attacker";
  await assert.rejects(inspectSubmission(gh, { pr: 7, head }, rock), CharacterRejection);
});

test("queued custom identities reserve defaults without executing source and require trusted provenance", async () => {
  const repo = "example/land", bot = "private-app[bot]", head = "a".repeat(40), path = "src/characters/cave-name.js";
  const source = 'throw new Error("Never execute me"); BL.characters.add({ handle: "cave-name", github: "owner", dress: { eyes(k, v) {} } });';
  const entry = { pr: 7, head: "b".repeat(40), author: "owner", path, base: null, hash: digest(source), lane: "manual" };
  const state = { version: 1, lane: "manual", openedOn: "2026-10-04", entries: [entry] };
  const pr = { number: 8, state: "open", user: { login: bot }, head: { sha: head, ref: "automation/characters-manual-round", repo: { full_name: repo } },
    base: { ref: "rock", repo: { full_name: repo } } };
  let verified = true, savedSource = source;
  const gh = { repo, list: async () => [pr, { ...pr, user: { login: "other" } }],
    api: async (url) => {
      if (url === "pulls/8") return pr;
      if (url === `commits/${head}`) return { author: { login: bot }, commit: { verification: { verified } } };
      throw new Error(`Unexpected API call ${url}`);
    },
    file: async (sha, filename) => {
      assert.equal(sha, head);
      if (filename === manifestPath("manual")) return { source: JSON.stringify(state) };
      if (filename === path) return { source: savedSource };
      throw new Error(`Unexpected queued file ${filename}`);
    }
  };
  assert.deepEqual(await queuedCharacters(gh, bot), [{ path, base: null, character: { handle: "cave-name", github: "owner" } }]);
  verified = false;
  await assert.rejects(queuedCharacters(gh, bot));
  verified = true; savedSource += "\n// changed after scanning\n";
  await assert.rejects(queuedCharacters(gh, bot));
});

test("empty placeholders migrate to the scoped App without duplication, never merge empty, and reopen after merging", async () => {
  let bot = BOT, unexpected = false;
  const repo = "example/land", refs = new Map([["rock", "1".repeat(40)]]), files = new Map(), authors = new Map(), prs = [];
  let sequence = 2, mergeCalls = 0;
  const gh = {
    repo,
    list: async (path) => path.includes("state=closed") ? [] : prs.filter((pr) => pr.state === "open"),
    tree: async () => new Map(),
    file: async (sha, path) => files.get(`${sha}:${path}`) || null,
    commit: async (branch, expected, additions) => {
      assert.equal(refs.get(branch), expected);
      const sha = String(sequence++).padStart(40, "0"); refs.set(branch, sha);
      authors.set(sha, bot);
      for (const file of additions) files.set(`${sha}:${file.path}`, { source: file.source, sha });
      return sha;
    },
    api: async (path, method, data) => {
      if (path.startsWith("git/ref/heads/")) { const sha = refs.get(decodeURIComponent(path.slice(14))); return sha ? { object: { sha } } : null; }
      if (path === "git/refs") { refs.set(data.ref.slice(11), data.sha); return { object: { sha: data.sha } }; }
      if (path === "pulls" && method === "POST") {
        const pr = { number: prs.length + 1, state: "open", user: { login: bot }, head: { ref: data.head, sha: refs.get(data.head), repo: { full_name: repo } }, base: { ref: "rock", repo: { full_name: repo } } };
        prs.push(pr); return pr;
      }
      if (/^pulls\/\d+$/.test(path)) {
        const pr = prs.find((pr) => pr.number === Number(path.split("/")[1]));
        pr.head.sha = refs.get(pr.head.ref); return pr;
      }
      if (path.startsWith("commits/")) return { author: { login: authors.get(path.slice(8)) }, commit: { verification: { verified: true } } };
      if (path.startsWith("compare/")) {
        const sha = path.split("...")[1], lane = files.has(`${sha}:${manifestPath("daily")}`) ? "daily" : "manual";
        return { files: [{ filename: manifestPath(lane), status: "added" }, ...(unexpected ? [{ filename: "unsafe.js", status: "added" }] : [])] };
      }
      if (path.endsWith("/merge")) { mergeCalls++; throw new Error("Empty bundle must never merge"); }
      throw new Error(`Unexpected API call ${path}`);
    }
  };
  let coordinator = createCoordinator(gh, bot, () => new Date(NOW));
  const daily = await coordinator.ensure("daily"), manual = await coordinator.ensure("manual");
  assert.notEqual(daily.number, manual.number);
  assert.equal((await coordinator.ensure("daily")).number, daily.number);
  bot = "private-app[bot]";
  coordinator = createCoordinator(gh, bot, () => new Date(NOW));
  unexpected = true;
  await assert.rejects(coordinator.ensure("daily"), /unexpected files/);
  unexpected = false;
  for (const lane of ["daily", "manual"]) {
    const adopted = await coordinator.ensure(lane);
    assert.equal(authors.get(adopted.head.sha), bot);
  }
  assert.equal(prs.length, 2);
  await coordinator.mergeDaily();
  assert.equal(mergeCalls, 0);
  manual.state = "closed"; refs.set("rock", "f".repeat(40));
  const nextManual = await coordinator.ensure("manual");
  assert.notEqual(nextManual.number, manual.number);
  assert.equal((await coordinator.ensure("daily")).number, daily.number);
});

test("confirmed aliases roll up across stats without increasing event totals or granting the alias an identity", () => {
  const normalize = globalThis.BL.contributorIdentities.normalizeStats;
  const a = "email:bdb4923572c8ac13", b = "email:56537ddd43347582";
  const raw = snapshot(person("MrHodlX", { counts: { commits: 302 }, weekly: [{ week: "2026-W35", commits: 10 }] }),
    person(a, { counts: { commits: 4 }, weekly: [{ week: "2026-W35", commits: 4 }], type: "Bot" }),
    person(b, { counts: { commits: 1 }, weekly: [{ week: "2026-W34", commits: 1 }], first_seen_at: "2026-08-25T00:00:00Z", last_seen_at: "2026-10-04T11:30:00Z" }),
    person("claude", { counts: { commits: 14 } }));
  raw.totals = { contributors: 4, commits: 321 };
  raw.leaderboards = { commits: raw.contributors.map((row) => ({ login: row.login, count: row.counts.commits })) };
  raw.repos = [{ name: "entropylab", totals: { contributors: 2, commits: 10 },
    contributors: [{ login: "MrHodlX", last_seen_at: "2026-10-04T10:00:00Z" }, { login: a, last_seen_at: "2026-10-04T11:00:00Z" }],
    leaderboards: { commits: [{ login: "MrHodlX", count: 6 }, { login: a, count: 4 }] }, weekly: [{ week: "2026-W35", commits: 10 }] }];
  raw.recent = [{ login: a, repo: "entropylab", type: "commit", occurred_at: "2026-10-04T11:00:00Z" },
    { login: a, repo: "entropylab", type: "commit", occurred_at: "2026-10-04T11:00:00Z" }];
  const before = JSON.stringify(raw), result = normalize(raw, NOW);
  const owner = result.contributors.find((row) => row.login === "MrHodlX");
  assert.equal(owner.counts.commits, 307);
  assert.deepEqual(owner.attributed_logins, [b, a].sort());
  assert.equal(owner.first_seen_at, "2026-08-25T00:00:00.000Z");
  assert.equal(owner.last_seen_at, "2026-10-04T11:30:00.000Z");
  assert.deepEqual(owner.weekly.map((row) => row.commits), [1, 14]);
  assert.equal(owner.type, undefined);
  assert.equal(result.totals.commits, 321);
  assert.equal(result.totals.contributors, 2);
  assert.equal(result.leaderboards.commits[0].count, 307);
  assert.equal(result.repos[0].leaderboards.commits[0].count, 10);
  assert.equal(result.repos[0].contributors.length, 1);
  assert.equal(result.repos[0].contributors[0].last_seen_at, "2026-10-04T11:00:00.000Z");
  assert.deepEqual(result.repos[0].weekly, raw.repos[0].weekly);
  assert.equal(result.recent.length, 2);
  assert.ok(result.recent.every((row) => row.login === "MrHodlX"));
  assert.equal(result.contributors.find((row) => row.login === "claude").counts.commits, 14);
  assert.equal(normalize(result, NOW), result);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(contributorRows(raw, NOW).map((row) => row.handle), ["mrhodlx"]);
  const alone = normalize(snapshot(person(a)), NOW);
  assert.equal(alone.contributors[0].login, "MrHodlX");
  const harry = normalize(snapshot(person("Harry"), person("hotpixelgroup")), NOW);
  assert.deepEqual(harry.contributors.map((row) => row.login), ["hotpixelgroup"]);
  assert.equal(harry.contributors[0].counts.commits, 2);
  assert.deepEqual(contributorRows(harry, NOW).map((row) => row.handle), ["hotpixelgroup"]);
});

test("onboarding rejects bot aliases, unresolved identities, malformed dates and stale snapshots", () => {
  const rows = contributorRows(snapshot(person("New-Ooga"), person("NEW-OOGA"), person("robotics-human"),
    person("claude"), person("CODEX"), person("dependabot[bot]"), person("email:123"), person("../x"),
    person("machine", { type: "Bot" }), person("automation", { is_bot: true }), person("bad--login"),
    person("comments-only", { counts: { commits: 0, comments: 50, prs: 3, reviews: 2 } }),
    person("unknown-count", { counts: null }), person("string-count", { counts: { commits: "1" } }),
    person("future", { last_seen_at: "2027-01-01T00:00:00Z" }), person("no-date", { first_seen_at: null })), NOW);
  assert.deepEqual(rows.map((row) => row.handle), ["new-ooga", "robotics-human"]);
  assert.equal(rows[0].joined, Date.parse("2026-09-01T00:00:00Z") / 1000);
  assert.throws(() => contributorRows(snapshot(person("new-ooga")), NOW + 86400001));
  assert.throws(() => contributorRows({ ...snapshot(), meta: { org: "elsewhere", schema_version: 3 } }, NOW));
});

test("queued and just-merged custom characters reserve their handles and GitHub aliases against defaults", () => {
  const existing = [{ handle: "cave-name", github: "GitHub-Owner", look: { bald: true } }, { handle: "Another" }];
  const pending = [{ path: "src/characters/queued-alias.js", base: null, character: { handle: "Queued-Alias", github: "Waiting-Owner" } }];
  const rows = contributorRows(snapshot(person("github-owner"), person("CAVE-NAME"), person("another"), person("queued-alias"), person("waiting-owner"), person("new-ooga")), NOW);
  const missing = missingCharacters(rows, existing, pending);
  assert.deepEqual(missing.map((row) => row.handle), ["new-ooga"]);
  assert.equal(missingCharacters(rows, [...existing, ...missing], pending).length, 0);
  const collected = [];
  runInNewContext(characterSource(missing[0]), { window: { BL: { characters: { add: (row) => collected.push(row) } } } });
  assert.equal(collected[0].handle, "new-ooga");
  assert.equal(collected[0].joined, missing[0].joined);
  assert.equal(declaredIdentity(characterSource(missing[0])).handle, "new-ooga");
  assert.deepEqual(existing[0].look, { bald: true });
  const alias = { handle: "harry", joined: 1, lastCommit: 2 }, owner = { handle: "hotpixelgroup", joined: 1, lastCommit: 2 };
  const source = characterSource(alias), sourceFor = (file) => file === "harry.js" ? source : null;
  assert.deepEqual(retiredCharacters([alias, owner], sourceFor), [{ file: "harry.js", source }]);
  assert.deepEqual(retiredCharacters([alias], sourceFor), []);
  assert.deepEqual(retiredCharacters([alias, owner], () => source + "// Custom profile\n"), []);
});

test("queued additions retire only exact untouched generated defaults for their reserved identities", () => {
  const source = characterSource({ handle: "new-ooga", joined: 1, lastCommit: 2 });
  const entry = { path: "src/characters/new-ooga.js", base: null, character: { handle: "NEW-OOGA", github: "New-Ooga" } };
  const sourceFor = (file) => file === "new-ooga.js" ? source : null;
  assert.deepEqual(queuedDefaults([entry], sourceFor), [{ file: "new-ooga.js", source }]);
  for (const other of [
    { ...entry, base: "a".repeat(40) },
    { ...entry, character: { handle: "another", github: "another-owner" } }
  ]) assert.deepEqual(queuedDefaults([other], sourceFor), []);
  // Intake can reserve an alias after a build generated its owner's default.
  const alias = { ...entry, path: "src/characters/cave-name.js", character: { handle: "cave-name", github: "new-ooga" } };
  assert.deepEqual(queuedDefaults([alias, entry], sourceFor), [{ file: "new-ooga.js", source }]);
  assert.deepEqual(queuedDefaults([{ ...alias, base: "a".repeat(40) }], sourceFor), []);
  assert.deepEqual(queuedDefaults([entry], (file) => file === "new-ooga.js" ? characterSource({ handle: "another", joined: 1, lastCommit: 2 }) : null), []);
  for (const custom of [null, "not a character", source + "// Custom profile\n",
    source.replace("lastCommit: 2", 'lastCommit: 2, look: { skin: "#123456" }')]) {
    assert.deepEqual(queuedDefaults([entry], () => custom), []);
  }
});

test("a single aliased profile gains github; explicit mappings and ambiguous batches are preserved", () => {
  const row = (file, handle, github) => ({ file, character: { handle, ...(github ? { github } : {}) } });
  assert.equal(identityAdvice([row("cave-name.js", "cave-name")], ["src/characters/cave-name.js"], "real-owner")[0].github, "real-owner");
  assert.equal(identityAdvice([row("Real-Owner.js", "Real-Owner")], ["src/characters/Real-Owner.js"], "real-owner")[0].mismatch, false);
  const explicit = identityAdvice([row("cave-name.js", "cave-name", "real-owner")], ["src/characters/cave-name.js"], "maintainer")[0];
  assert.equal(explicit.github, null);
  assert.equal(explicit.login, "real-owner");
  const batch = [row("one.js", "one"), row("two.js", "two")];
  assert.ok(identityAdvice(batch, batch.map((r) => `src/characters/${r.file}`), "maintainer").every((r) => r.missing));
  const occupied = [row("alias.js", "alias"), row("owner.js", "owner", "real-owner")];
  assert.equal(identityAdvice(occupied, ["src/characters/alias.js"], "real-owner")[0].missing, true);
  const maintained = identityAdvice([row("new-owner.js", "new-owner")], ["src/characters/new-owner.js"], "maintainer", true)[0];
  assert.equal(maintained.login, "new-owner");
  assert.equal(maintained.github, null);
  assert.equal(maintained.missing, false);
});

test("identity declarations are read without executing PR code and owners cannot impersonate or transfer profiles", () => {
  const source = 'throw new Error("Never execute me"); BL.characters.add({ handle: "alias", github: "owner", dress: { eyes(k, v) { return { a: 1 }; } } });';
  const identity = declaredIdentity(source);
  assert.deepEqual(identity, { handle: "alias", github: "owner" });
  assert.equal(mayAuthorIdentity("owner", identity, null, false), true);
  assert.equal(mayAuthorIdentity("attacker", identity, null, false), false);
  assert.equal(mayAuthorIdentity("maintainer", identity, null, true), true);
  assert.equal(mayAuthorIdentity("attacker", { handle: "alias", github: "attacker" }, identity, false), false);
  assert.equal(mayAuthorIdentity("owner", { handle: "new-alias", github: "owner" }, identity, false), true);
  for (const body of ['handle: "one", github: "two", github: "one"', 'handle: login', 'handle: "one", ...other', 'handle: "one", [key]: "two"', 'get handle() { return "one"; }']) {
    assert.throws(() => declaredIdentity(`BL.characters.add({ ${body} });`));
  }
  // The established custom profiles remain legal under the declarative reader.
  for (const name of readdirSync(new URL("../../src/characters/", import.meta.url)).filter((name) => name.endsWith(".js"))) {
    assert.ok(declaredIdentity(readFileSync(new URL(`../../src/characters/${name}`, import.meta.url), "utf8")).handle);
  }
});

test("signed-in lookups coalesce requests, expire without timers and fail closed on outages", async () => {
  let now = NOW, calls = 0, fail = false;
  const lookup = createContributorLookup(async () => {
    calls++;
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify(snapshot(person("new-ooga"))));
  }, () => now);
  const results = await Promise.all([lookup("new-ooga"), lookup("NEW-OOGA"), lookup("visitor")]);
  assert.equal(calls, 1);
  assert.equal(results[0].handle, "new-ooga");
  assert.equal(results[1].handle, "new-ooga");
  assert.equal(results[2], null);
  now += 60001; fail = true;
  assert.equal(await lookup("new-ooga"), null);
  assert.equal(await lookup("new-ooga"), null);
  assert.equal(calls, 2);
  now += 15001; fail = false;
  assert.equal((await lookup("new-ooga")).handle, "new-ooga");
});

test("the browser accepts one matching temporary identity without reordering the bundled crew", () => {
  const context = { window: {}, URLSearchParams, location: { search: "" } };
  for (const name of ["math", "characters", "contributor-identities", "activity-repos"]) runInNewContext(readFileSync(new URL(`../../src/js/${name}.js`, import.meta.url), "utf8"), context);
  const BL = context.window.BL;
  BL.characters.add({ handle: "alias", github: "owner", joined: 1, lastCommit: 2 });
  runInNewContext(readFileSync(new URL("../../src/js/contributors.js", import.meta.url), "utf8"), context);
  const c = BL.contributors, row = { handle: "new-ooga", joined: 1, lastCommit: 2 };
  assert.equal(c.addTemporary(row, "somebody-else"), false);
  assert.equal(c.addTemporary({ ...row, handle: "owner" }, "owner"), false);
  assert.equal(c.addTemporary(row, "NEW-OOGA"), true);
  assert.equal(c.addTemporary({ ...row, handle: "second" }, "second"), false);
  assert.equal(c.roster[0].name, "alias");
  assert.equal(c.roster.length, 2);
  assert.equal(c.activeRoster[1].temporary, true);
  assert.equal(BL.characters.get("new-ooga").temporary, true);
});
