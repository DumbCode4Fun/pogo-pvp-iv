# PvP IV Calculator

Ranks every Pokémon GO IV spread (all 4,096) for Great, Ultra and Master League and the current cups by
stat product, compares your own spreads side by side, and shows PvPoke's league and cup rankings.
A static site with no build step: open `index.html` (the Raid, Dynamax and Box tabs need it served over http, see below).

## Tabs and where rosters are saved

The page has four tabs: **PvP IVs**, **Raid** (the raid calculator, with its Upgrades view), **Dynamax**
(a Max Battle solver, built on estimates) and **Box** (every account's Pokémon, with the CP the game shows,
which the other three read). The Dynamax tab only uses the Pokémon ticked **Dynamax** (and **G-Max** for
Gigantamax) on the Box tab. The code for Raid, Dynamax and Box lives in `raid/` and renders inside a shadow root
so its styles stay separate; it is loaded the first time one of those tabs opens and needs the page served over
http. The tab is kept in the URL (`#raid`, `#box`...), so Back and bookmarks work.

The Box holds your account rosters, and `storage.js` decides where they live:

- **Local server** (`node pvp-iv/serve.mjs`): rosters are saved as plain JSON in `data/accounts/`, one
  file per account that you can edit by hand, and the raid setup and tuning in `data/settings.json`.
- **Anywhere else** (GitHub Pages, a file): rosters are saved in that browser's localStorage and never uploaded.
  Use **Back up all accounts** / **Restore from backup** on the Box tab to back them up or move them to another browser.
- **The cloud**, when `cloud-config.js` names a Firebase project and someone signs in (`cloud.js`): rosters
  are saved in Firestore for a group of Google accounts. Setup: `firebase/SETUP.md` in the main folder.

Whichever it is, each account is saved on its own and only if it is still at the revision the page loaded,
so two tabs or devices can't overwrite each other: a refused save shows what is saved instead.

The PvP tab reads the same rosters: under **Your IV spreads**, pick an account and its Pokémon that are, or can
evolve into, the species on screen are listed next to the spreads you typed. **Comparison** and **Across leagues**
rate them at their own IVs, with the level each league wants and whether the Pokémon is ready, needs power-ups,
or is already over the CP cap. **Best spreads** notes the spreads you own. Edit them on the Box tab.

One account's roster also goes in and out as CSV on the Box tab: **Export CSV**, **Add from CSV** (adds only what
isn't there yet) and **Replace from CSV**. A hand-made CSV needs only a `name` and a `cp` per Pokémon; the level is
solved from the CP. The columns are listed at the top of `raid/roster-import.js`.

## Keeping the data fresh

`data.js` holds the Pokémon, evolution lines, cups and rankings. A GitHub Action
(`.github/workflows/refresh-data.yml`) rebuilds it every day from [PvPoke](https://github.com/pvpoke/pvpoke)'s
published data and commits it when it changed, so new cups and re-simulated rankings show up on their own.
You can also run it from the repo's **Actions** tab ("Refresh PvPoke data" → "Run workflow").

Because the bot commits to `main`, run `git pull` before pushing your own changes.

To rebuild by hand: `node build-data.mjs` (Node 18+).

## What the automatic refresh does not cover

`base.json` is a snapshot of base stats and the CP table. New Pokémon with a brand-new dex number are
added automatically from PvPoke, but a new *form* of a Pokémon that's already listed (a new regional
variant, say) needs `base.json` regenerated from the raid calculator's game data
(`node pvp-iv/extract-base.mjs` in that project).

Rankings and scores are PvPoke's, MIT-licensed, and rate each Pokémon rather than your IVs.
