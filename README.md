# PvP IV Calculator

Ranks every Pokémon GO IV spread (all 4,096) for Great, Ultra and Master League and the current cups by
stat product, compares your own spreads side by side, and shows PvPoke's league and cup rankings.
A static site with no build step: open `index.html` (the Raid tab also needs it served over http, see below).

## Tabs and where rosters are saved

The page has three tools: **PvP IVs**, **Raid** (the raid calculator, with its Upgrades view) and **Dynamax**
(a Max Battle solver, built on estimates). The Dynamax tab only uses the Pokémon ticked **Dynamax** (and
**G-Max** for Gigantamax) in the rosters on the Raid tab. The raid code lives in `raid/` and renders inside a shadow root so its
styles stay separate; it is loaded the first time the Raid tab opens and needs the page served over http. The tab is kept in the URL (`#raid`), so Back and bookmarks work.

Raid and Dynamax need your account rosters, and `storage.js` decides where they live:

- **Local server** (`node pvp-iv/serve.mjs`): rosters are saved as plain JSON in `data/accounts/`, one
  file per account that you can edit by hand, and the raid setup and tuning in `data/settings.json`.
- **Anywhere else** (GitHub Pages, a file): rosters are saved in that browser's localStorage and never uploaded.
  Use **Back up all accounts** / **Restore from backup** on the Raid tab to back them up or move them to another browser.

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
