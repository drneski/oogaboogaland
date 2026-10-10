# Ooga Booga Land

A WebGL2 floating island whose cliff caves hold projects and an arcade of games. Voxel cavemen stand in for the contributors of [OogaBoogaX](https://github.com/OogaBoogaX); donated bananas feed them, the live Bitcoin mempool makes the weather, and the rim Oogatron shows the org's live stats. Plain JavaScript, no dependencies, read-only network connections only. Payments are a simulator for now; visitor state stays in the visitor's browser.

## Run it

Open `src/index.html` in a browser, or serve `src/` with any static server.

```sh
npm run serve   # build and stage the site, then serve it at http://127.0.0.1:8080/ (try /oogarally)
npm run watch   # the same, rebuilding on every change under src/
```

`PORT` picks another port and `HOST=0.0.0.0` opens the server to the network. Reload the tab after a rebuild.

## The island

- **Destinations:** press the hub/map button to cycle places, or select a dot. **MEMPOOL** goes to the underground room below the rainforest lake.
- **Fly:** **W A S D**, **Q E** turn, **Z**/**Space** up, **X** down; drag to orbit, scroll to zoom. On a phone the left stick moves and the right stick looks.
- **Play an Ooga:** double-tap one. Hold **Left Shift** while moving to run. **Space** jumps (twice for a double jump) and uses whatever is beside you; **Escape** lets go.
- **Factory ladders:** walk into a ladder to attach automatically. **W/S** climb up/down, **A/D** shift sideways, and **Space** jumps off. Walking outward onto a ladder from its upper landing starts a descent; release the movement key, then use **W/S** to change direction.
- **Play a gorilla:** double-click or double-tap one to take control. **W A S D** walks, hold **Left Shift** to run, and **Space** jumps with an optional second jump in the air. Controlled gorillas walk at 1.8 m/s and run at 5.4 m/s, twice the NPC pace, with the same animations.
- **Gorilla views:** **X** switches carry/combat. Scroll between first person, shoulder, and orbit/bird's-eye; combat shows the same crosshair. **Right-click** returns to shoulder, **Right Shift** swaps shoulders (**Right Shift + A/D** peeks), and **Q/E** rotate bird's-eye with **N** for north. **C** beats its chest.
- **Gorilla attacks:** hold **Left mouse** to charge a smash; rapid hits are weaker until the power bar recovers. Hold **G** to grab an Ooga riding on you; release **G** to drop them. While holding **G**, hold **Left mouse** to charge a throw, then release the mouse to throw toward the crosshair. You can run and jump while carrying them.
- **Gorilla rage:** while signed out, hitting an uncontrolled chilling gorilla with 42 distinct banana rounds within 60 seconds makes it chase the Oogas who agitated it, drag them past nearby Oogas and small props to an inland throwing position, and throw them over the hills toward the nearest usable coast. Raging gorillas show the Agent's original bright green pattern, and nearby NPC Oogas flee as they do from fire. Rage lasts at most 60 seconds; emptying its health bar ends it sooner. Signing in cancels rage. See [gorilla behavior and multiplayer handoff](docs/gorilla-behavior.md).
- **Views:** **X** switches carry and combat. Combat has first-person, shoulder and birds-eye (scroll out from shoulder); in birds-eye move the mouse up/down to aim along the centerline from the screen's center to its top, and sideways to turn the view. **Q E** also rotate and **N** turns north up. **Right-click** returns to shoulder. In shoulder view, **Right Shift + A/D** peeks; tap **Right Shift** to switch shoulders.
- **Weapons:** **G** switches, **1** club, **2** rifle. **Left mouse** fires or swings (hold to charge), **F** strikes with the rifle in combat mode, **R** swaps magazines, **Space** at the pile reloads. Boxes, barrels and rocks break and drop pickups; the mirror cracks and heals.
- **Reset:** **Right Shift + R** resets saved progress. **Left Shift + R** keeps running while swapping magazines.
- **Jetpack:** **J** puts it on; hold **Space** to climb. After a throw, steer back toward the island to brake and reverse the launch momentum while fuel remains.

Roster colours show activity across every OogaBoogaX repo: yellow worked in the last hour, orange in the last day, gray asleep. Working Oogas load bananas at the pile and shoot them into their project's cave, where their gorilla companions build. HQ's ramps lead down to a basement of beds.

Around the rim: **EntropyLab** (11 o'clock), the **Lightning Factory** (2), **Ooga Arcade** (3), where a cabinet opens each game, the **Mempool island** (4) and the **Timechain Sphere** (southwest). Every game opens on a title card; **Enter** starts, **Escape** leaves.

## Playing together

On the Cloudflare Workers ([oogabooga.land](https://oogabooga.land), and [staging](https://oogaboogaland-staging.wickedsmartbitcoin.workers.dev)), **Sign in with GitHub** at the foot of the side panel to share the island. Signed-in players see each other: whoever drives an Ooga appears as that Ooga, moving live, with their name above it, while the rest of the crew keeps working around them. The panel shows how many are online. Opening the island in a second tab moves you there; the first tab offers **Play here** to move back.

Signed-in players also share the crew: one player's page runs the Oogas for everyone, so each Ooga walks, works and sleeps in the same place on every screen. If that player leaves, another page takes over by itself.

Who drives which Ooga:

- **Contributors drive their own.** If your GitHub login is a contributor's in `src/characters/`, signing in hands you your own Ooga, and while you are signed in nobody else can drive it. Your Ooga's face stays beside the location button; click it while detached to retake control. Contributors drive only their own Ooga.
- **Everyone else** (signed in or not) may drive an Ooga only when its contributor is not signed in, nobody else is driving it, and it is not working (yellow in the roster). Resting and sleeping Oogas are free to borrow.
- **Owners come first.** When a contributor signs in, their Ooga is handed back to them, and whoever was driving it lets go.

Players driving an Ooga can also talk: **Join voice** at the foot of the panel asks for your microphone, then becomes **Mute**. You hear everyone driving an Ooga in the same place as you, all at the same volume: out on the island, in HQ, or inside the same cave. Step into a cave and you hear only who is in there with you.

Ownership goes by GitHub login, not by name. These rules apply on the signed-in site; the plain GitHub Pages build has no accounts and every Ooga is free there. How it works: `docs/auth-and-presence.md`.

## Timechain Sphere

Sani's hangout: a walk-in sphere whose six inner walls show live [Timechain Index](https://timechainindex.com) data (BTC distribution, address balances, UTXO sizes, ETF and exchange holdings, top holders). The walls load once you come near and refresh every five minutes. Tap a wall for a close-up and its source; tap Sani to spin his chair. Holdings are on-chain balances and API attributions, not proof of ownership. `timechain=0` turns the feed off.

## Games

- **The Ember Den:** walk through its window in ₿IFRÖST, beside DSB Land's, straight into a room of ten poker tables, nine seats each, suited gorilla dealers and five cave themes. Local practice plus an experimental encrypted-deck multiplayer service (`npm run poker:serve`), private dealing and downloadable hand verification. Free play chips, no payments or rake. See [status](docs/banana-poker.md) and [protocol and service instructions](docs/poker-protocol.md).
- **Ooga Rally:** three laps on one of three tracks. **W** go, **S** brake, **A D** steer, hold **Space** to drift and release to boost, **E** throws your item. Win gold in the Cup to open Mirror.
- **Ooga Drop:** jump from the plane, fly through eight hoops (**W S** pitch, **A D** roll, **Q E** turn), **Space** pulls the chute, land on the pile.
- **Ooga Orbit:** build a rocket, launch, reach the Sky Top at 500 up, spacewalk to measure the space rock (**V**), then fall home shield first and chute onto the pad.
- **Ooga Mine:** a mining tycoon about margin. Place gear, watch power, heat and the halving, put out fires, and mine 21 coin within the hour. **W A S D** walk, **Space** works, **V** looks round, **P** pauses; the run saves as you go.
- **The Agent:** double-click it to play; **Left Shift** gallops, **Space** jumps, and a second press while airborne adds a double jump. Each jump is 50% higher than an Ooga's. **C** beats its chest. **Right Shift + A** summons or releases it in scenes with an Agent.

## Weather

The mempool is the Mempool island: transactions arriving make its weather (six steps, dry to downpour, and the wind), everything waiting fills its lake, which floods the shore and pours over the cliffs when the backlog is deep, and every block strikes lightning and drops a cube of the lake through the chamber underneath, where wall paintings read the chain out. Walk in through the hill by the bridge.

## Debug

Each game and cave has an address to share, with its own preview card: `/oogarally`, `/oogadrop`, `/oogaorbit`, `/oogamine`, `/mempool`, `/dsb`, `/entropylab`, `/lightning` and `/sphere`. They work on the site and under `npm run serve`, and as `oogaboogaland.html#/oogarally` when the file is opened from disk; routes live in `src/js/routes.js`, and `npm run cards` recaptures the cards. `?scene=lab`, `race`, `drop`, `orbit`, `mine` or `dsb` opens that scene; `?nosim=1` silences the simulator and every feed; `?canvas2d=1` forces the Canvas 2D fallback; `?debug=1` exposes `window.__ooga`. AGENTS.md lists every flag and fixture.

With `debug=1&poolfill=100`, pin the Mempool lake at half depth immediately. `poolfill` runs from 0 (empty bowl) to 200 (overflowing, with flooded shores and waterfalls), is clamped to that range, and ignores blank or invalid values. It controls depth from the bowl bottom through the full flood level, not volume or transaction backlog. Overflow starts around 176; 180 and 190 show partially filled trenches, and 200 fills the trenches completely. It leaves the live rain unchanged. Omit it for the live backlog level. In the debug console, `__ooga.poolIsland.preview.fill(150)` changes it without reloading; `fill(null)` restores the feed.

With `debug=1&poolblock=1`, trigger one block-cube drop from the bottom of the lake per island visit. It uses the normal gathering, hanging and falling animation without changing the backlog or rain. The rounded water cube floats freely for 4.5 seconds before dropping; hover over it to show its block height above it. Debug cubes capture the current known chain height (or show that it is unavailable). Add `view=mempool` to start in the underground chamber, then turn toward the central shaft to watch. While the flag is on, press **P** for another block animation (lightning and cube); it replaces the normal pile shortcut for that visit.

With `debug=1`, contributor states follow activity timestamps; debug mode alone does not reseed or override them. Pass `status=clankin`, `status=chillin` or `status=sleepin` to pin everyone to one state, or repeat `ooga=<handle>:<mode>[:<caves>]` to set individual owners to `clank`, `chill` or `sleep`. Once any `ooga` flag is present, unlisted owners and omitted/invalid modes sleep, including maintainers and Sani. This fixture overrides `status=` and live activity for the visit. GitHub logins also work. Repeating an owner replaces its earlier setting. The companion gorillas follow their owners' modes.

Clanking requires a comma-separated cave list: `lab` for EntropyLab, `obl` for Ooga Booga Land, and `lf` for Lightning Factory. Cave IDs (`c11`, `c1`, `c2`) and repository names (`oogaboogax/entropylab`, `oogaboogax/oogaboogaland`, `oogaboogax/lightningfoundry`) also work. Historical Lightning Factory/Foundry names and `bananapayserver` resolve to LF. Unknown caves are ignored; a clank entry with no valid caves sleeps. Workers cycle through only their listed caves. `&ooga=` makes everyone sleep. In normal play, recent contributions to either `lightningfoundry` or `bananapayserver` send the Ooga and its Clanker to the Lightning Factory cave.

Example: five clanking owners, five chilling owners, and everyone else sleeping. w-s-bitcoin visits all three repositories, portlandhodl visits lab/OBL, DrNeski visits lab/LF, bc1gui visits the lab, and 2140data visits OBL. Append this query to the built page's address:

```text
?debug=1&nosim=1&ooga=w-s-bitcoin:clank:lab,obl,lf&ooga=portlandhodl:clank:lab,obl&ooga=DrNeski:clank:lab,lf&ooga=bc1gui:clank:lab&ooga=2140data:clank:obl&ooga=SaniExp:chill&ooga=MrHodlX:chill&ooga=Holo-Elfstone:chill&ooga=Tmmmemcee:chill&ooga=YellowBrokeIt:chill
```

In the hub, `?debug=1&character=gorilla-SaniExp` starts controlling SaniExp's gorilla. `clanker-SaniExp` is an equivalent selection, and both prefixes work with `solo=1`. A sleeping selected contributor is woken for this debug visit. Click the canvas to focus combat controls.

While controlling a gorilla, **Space** jumps immediately; press it again in the air for the optional second jump. Holding does not charge or repeat. Walk toward a nearby climbable wall or edge to mount it. On the wall, **W/S** climb up/down and **A/D** move sideways; combine them for diagonal climbing. Automatic mounting and dismounting preserve the camera's position; look and zoom remain available, and camera following resumes smoothly when you move again.

With `?debug=1&gorillamove=1`, use detached mode to click a gorilla, then click its destination on the ground, a ledge or a wall. The selected gorilla stays highlighted and plans walking and climbing from its current position. Wall routes can move sideways or diagonally while keeping the gorilla facing the stone. Click another destination to redirect it; **Escape** deselects it. A marker and status show its progress, and a blocked climb stays in place for inspection. The former `climbers=1` flag is an alias for this mode.

With `?debug=1&nosim=1&status=chillin&gorillarage=1`, click an awake gorilla while detached to start continuous rage. It targets eligible Oogas within 35 m without requiring banana hits, using the normal grab, drag, charge and throw sequence. Click another gorilla to switch; **Escape** stops it and releases any captive. Possession, health depletion, signing in or leaving the scene also stops it. This debug flag takes precedence over `gorillamove=1`; ordinary rage keeps its 60-second limit and only targets its agitators.

## Test

```sh
npm test
```

A headless Chrome suite over the DevTools protocol, a clean console required. Needs Node 22+ and Chrome (`CHROME` points at the binary off macOS). `npm run test:full` is the full gate.

## Build and deploy

```sh
npm run build
```

Writes `oogaboogaland.html`, one self-contained page with the content policy pinned to its hashes. CI commits it back after each merge to `rock`, and GitHub Pages serves it at https://oogaboogax.github.io/oogaboogaland/.

Two Cloudflare Workers serve the same site with GitHub sign-in, the shared island and voice: https://oogaboogaland-staging.wickedsmartbitcoin.workers.dev and https://oogabooga.land (production) both deploy by hand through GitHub Actions; `docs/cloudflare-setup.md` covers the setup and local development with `wrangler dev`, and `docs/auth-and-presence.md` the sign-in flow.

### Deploying to Cloudflare

Deploy only through GitHub Actions, and keep Cloudflare's Git connection (Workers Builds) **off** on both Workers. Two deploy systems on the same push race each other. On 2026-10-03 the Git connection deployed a static-only build next to Actions and wiped staging's secrets, which took down sign-in and voice.

| Environment | URL | Deploys |
|---|---|---|
| Staging | https://oogaboogaland-staging.wickedsmartbitcoin.workers.dev | by hand: **Actions → Deploy Cloudflare staging → Run workflow** on `rock` |
| Production | https://oogabooga.land | by hand once staging looks right: **Actions → Deploy Cloudflare production → Run workflow** on `rock` |

Each workflow builds the site (`npm run build:site`), runs the Worker's checks, applies D1 migrations and deploys with `wrangler.<env>.jsonc`. A deploy drops live connections for a moment, and players reconnect on their own.

Don't:
- connect a Git repository under a Worker's **Settings → Build**;
- use **Edit code**, quick edit or deploy buttons on these Workers in the dashboard;
- run a plain `wrangler deploy` without `--config wrangler.<env>.jsonc`.

After each deploy, from `worker/`:
1. `npx wrangler deployments list --config ../wrangler.<env>.jsonc` shows one new deploy for the push.
2. `npx wrangler secret list --config ../wrangler.<env>.jsonc` lists `GITHUB_CLIENT_SECRET` and `REALTIME_SECRET`.
3. `curl -s https://<host>/api/me` returns `{"player":null}`, not HTML.
4. Two players, one of them in a second browser or a private window, sign in with GitHub, see each other move, and hear each other after **Join voice**.

**Emergency deploy**, only when GitHub Actions is unavailable. Run it from an up-to-date checkout of `rock`, logged in with `npx wrangler login` as a member of the Cloudflare account:

```sh
cd worker
npm ci
npm run deploy:staging      # or: npm run deploy:production
```

The scripts build the site, apply D1 migrations and deploy with the right config. They ship whatever is checked out, so pull `rock` first, then run the checks above.

**If sign-in or voice breaks after a deploy**, `wrangler deployments list` shows what deployed. A deploy that didn't come from Actions means something else is deploying: disconnect it. Then set that environment's own secrets again from the shared password manager:

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET --config ../wrangler.<env>.jsonc
npx wrangler secret put REALTIME_SECRET --config ../wrangler.<env>.jsonc
```

Secrets take effect at once, without a redeploy.
- **Lost secrets:** a lost OAuth secret is regenerated on its GitHub OAuth App. A lost Realtime App Secret means a new SFU app, whose App ID goes into `REALTIME_APP_ID`.
- **"GitHub did not answer"** means a missing or wrong `GITHUB_CLIENT_SECRET`.
- **"Voice unavailable"** means a missing `REALTIME_SECRET` or `REALTIME_APP_ID`.

To add your Ooga, add one file to `src/characters/` named after your GitHub handle; click **2140data** on the island for a prompt that walks you through it.

## Privacy

No analytics and no personal data. Read-only requests only, nothing about the visitor sent: mempool.space (falling back to Esplora), Coinbase and other public price feeds, the oogatron stats worker and Timechain Index. The donation handle and message stay in localStorage.

On the Cloudflare site, signing in with GitHub is optional. A signed-in player's GitHub id, login, avatar URL, display name and session records are kept in the site's database until they sign out, the session expires or they delete the account (`DELETE /api/me`). The GitHub token is used once and never stored. Nothing is kept for visitors who don't sign in.

DSB Land additionally contacts public Bitcoin feeds and radio/media services; payment is always an explicit action in the visitor's wallet. Zuzu uses local mock replies and deterministic fallback and sends no conversations to an AI provider. Its provider-neutral backend is prepared but not deployed.

## License

Public domain under [The Ooga Booga License](LICENSE), a caveman-speak dedication with the meaning of The Unlicense.

## Contributing

Read [AGENTS.md](AGENTS.md) first: the module layout, the engine patterns, how to add things, and the checks every change must pass.

## DSB Land

Reached through **₿IFRÖST** beyond the north pass. Walk through the DSB window in its chamber. To come home, use the **DSB Dialer** beside the upright gate and walk back through it into ₿IFRÖST.

Inside: a river boat and the **Bitcoin coaster** (ride on the live price), the **Meme Shop** (demo tokens for snacks and tomatoes), and **NodeRunner TV**, whose radio takes song requests paid over Lightning from your own wallet. **Turtle view** shows the whole land. A direct visit is `?scene=dsb`.

### Zuzu

Zuzu is DSB Land's physical black cat. Approach her and choose **Talk to Zuzu** for a compact free-form conversation panel. Replies are currently clearly labelled local mocks, with deterministic fallback; no real AI provider is connected. Conversation history resets when leaving DSB. The provider-neutral backend foundation is documented in [server/zuzu/README.md](server/zuzu/README.md); it is not deployed or bundled into the game.
