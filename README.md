# PvP IV Calculator

Ranks every Pokémon GO IV spread (all 4,096) for Great, Ultra and Master League and the current cups by
stat product, compares your own spreads side by side, and shows PvPoke's league and cup rankings.
A static site with no build step: open `index.html`.

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
