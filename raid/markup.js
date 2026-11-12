/**
 * The raid UI's markup: a header with the Raid / Upgrades switch, then the three views (Raid,
 * Upgrades, and the Max Battle solver shown by the Dynamax tab).
 * Rendered into a shadow root by mount.js (ids are looked up there, see ui.js).
 */
export const MARKUP = `
<header class="topbar">
  <div class="topbar-left">
    <nav class="topnav" id="raidNav" aria-label="Raid views">
      <button type="button" data-view="raid" class="active" aria-current="page">Raid</button>
      <button type="button" data-view="upgrades">Upgrades</button>
    </nav>
  </div>
  <div class="topbar-meta">
    <span id="dataVersion" class="muted">loading data…</span>
    <span id="saveStatus" class="save-status"></span>
  </div>
</header>

<div id="view-raid">
<main>
      <div class="col-left">
      <!-- ------------------------------------------------ raid setup -->
      <section class="panel" id="setupPanel">
        <h2>The raid</h2>
        <div class="grid">
          <label class="field span2">
            <span>Boss</span>
            <div id="bossPicker"></div>
          </label>

          <label class="field">
            <span>Tier</span>
            <select id="tier"></select>
          </label>

          <label class="field">
            <span>Weather</span>
            <select id="weather"></select>
          </label>

          <label class="field">
            <span>Boss fast move <em>(optional)</em></span>
            <select id="bossFast"></select>
          </label>

          <label class="field">
            <span>Boss charged move <em>(optional)</em></span>
            <select id="bossCharged"></select>
          </label>

          <label class="field checkbox" id="gemsField" hidden>
            <input type="checkbox" id="purifiedGems" />
            <span>Using Purified Gems <em>(8 across the group calms the boss)</em></span>
          </label>
        </div>

        <details id="tuningDetails">
          <summary>Assumptions &amp; tuning</summary>
          <p class="muted small">
            Nothing here is per-boss — the boss’s own stats and move timings come from the game data. These are
            the numbers outside that, ordered by how much they are worth changing.
          </p>
          <div class="grid" id="tuningGrid"></div>
          <button type="button" class="ghost" id="resetTuning">Reset to defaults</button>
        </details>

        <div class="actions">
          <button type="button" id="runBtn" class="primary">Calculate</button>
          <label class="checkbox inline">
            <input type="checkbox" id="autoRun" checked />
            <span>Recalculate automatically</span>
          </label>
        </div>
      </section>

      <!-- ------------------------------------------------ rosters -->
      <section class="panel" id="rosterPanel">
        <h2>Accounts</h2>
        <div id="accountTabs" class="tabs"></div>

        <div id="accountSettings" class="grid"></div>

        <div class="roster-head">
          <h3>Roster <span id="rosterCount" class="muted small"></span></h3>
          <input type="search" id="rosterFilter" placeholder="Filter by name" aria-label="Filter the roster by Pokémon name" autocomplete="off" spellcheck="false" />
        </div>
        <div class="table-scroll">
          <table id="rosterTable">
            <thead>
              <tr>
                <th class="col-mon"><button type="button" class="th-sort" data-roster-sort="name" title="Sort by name (click again to flip, a third time for the order they were added)">Pokémon</button></th>
                <th><button type="button" class="th-sort" data-roster-sort="level" title="Sort by level, highest first (click again to flip, a third time for the order they were added)">Lvl</button></th>
                <th>Atk</th>
                <th>Def</th>
                <th>Sta</th>
                <th>Shadow</th>
                <th title="Can join Max Battles (used by the Dynamax tab)">Dynamax</th>
                <th title="Gigantamax: only the 17 species with a G-Max form">G-Max</th>
                <th>Mega</th>
                <th>Fast move</th>
                <th>Charged moves</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="rosterBody"></tbody>
          </table>
        </div>

        <div class="add-row">
          <div id="addPicker" class="grow"></div>
          <button type="button" id="addBtn">Add to roster</button>
        </div>

        <div class="actions secondary">
          <button type="button" class="ghost" id="exportCsv">Export CSV</button>
          <button type="button" class="ghost" id="addCsvBtn" title="Adds the Pokémon not already in this roster; ones already there can get Dynamax / G-Max ticked">Add from CSV</button>
          <button type="button" class="ghost danger" id="replaceCsvBtn" title="Replaces this whole roster with the file">Replace from CSV…</button>
          <input type="file" id="importCsv" accept=".csv,text/csv" hidden />
          <button type="button" class="ghost" id="copyRoster">Copy roster to…</button>
          <button type="button" class="ghost danger" id="clearRoster">Clear roster</button>
        </div>
        <div id="csvNote" class="muted small csv-note"></div>

        <div class="actions secondary">
          <button type="button" class="ghost" id="backupAll">Back up all accounts (JSON)</button>
          <button type="button" class="ghost danger" id="restoreAll">Restore from backup…</button>
          <input type="file" id="restoreFile" accept=".json,application/json" hidden />
        </div>
        <p id="storageNote" class="muted small"></p>

        <details open class="friend-block">
          <summary>Friendships between accounts</summary>
          <p class="muted small">
            Each trainer gets the raid bonus of their <b>highest</b> friendship with anyone in the raid — bonuses
            from several friends don't stack.
          </p>
          <div id="friendships"></div>
        </details>
      </section>

      </div>

      <!-- ------------------------------------------------ results -->
      <section class="panel results" id="resultsPanel">
        <h2>Verdict</h2>
        <div id="results"><p class="muted">Add some Pokémon and hit Calculate.</p></div>
      </section>
    </main>
</div>

<div id="view-upgrades" hidden>
<main class="single">
      <section class="panel">
        <h2>What to upgrade</h2>
        <p class="muted small">
          Power-ups and TMs, judged across every raid rather than just the one on the Raid page. This view only
          reads your rosters (it never saves) and refreshes whenever you switch to it after editing on the Raid view.
        </p>
        <div class="actions">
          <button type="button" class="ghost" id="recalc">Recalculate</button>
          <span id="status" class="muted"></span>
        </div>
        <div id="views" class="tabs" role="tablist"></div>
        <div id="accounts" class="tabs account-filter" role="tablist"></div>
        <div id="content"><p class="muted">Loading…</p></div>
      </section>
    </main>
</div>

<div id="view-max" hidden>
  <main class="single">
    <section class="panel">
      <h2>The Max Battle</h2>
      <div class="note warn">
        <b>An estimate.</b> The game doesn't publish Max Battle boss HP, damage or timings, so this runs on community figures
        and guesses (listed under Assumptions). Use it to compare teams and bosses; tie the numbers to a battle you really
        fought with the calibration under the verdict.
      </div>
      <div class="grid">
        <label class="field span2">
          <span>Boss</span>
          <div id="maxBossPicker"></div>
        </label>
        <label class="field">
          <span>Tier</span>
          <select id="maxTier"></select>
        </label>
      </div>

      <details id="maxTuningDetails">
        <summary>Assumptions &amp; tuning</summary>
        <p class="muted small">
          Each number is marked <b>sourced</b> (community figures that agree), <b>guess</b> (nothing published; a
          placeholder) or <b>choice</b> (a modelling decision). Only the ones you change are saved.
        </p>
        <div id="maxTuningGrid"></div>
        <button type="button" class="ghost" id="maxResetTuning">Reset to defaults</button>
      </details>
      <div class="actions">
        <button type="button" id="maxRun" class="primary">Solve</button>
        <span id="maxStatus" class="muted small"></span>
      </div>
    </section>

    <section class="panel">
      <h2>Verdict</h2>
      <div id="maxOut"><p class="muted">Pick a boss.</p></div>
    </section>
  </main>
</div>
`;
