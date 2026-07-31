import { Loop } from './core/Loop.js';
import { Camera } from './core/Camera.js';
import { Input } from './core/Input.js';
import { Assets } from './core/Assets.js';
import { Renderer } from './render/Renderer.js';
import { World } from './world/World.js';
import { Hud } from './ui/Hud.js';
import { Minimap } from './ui/Minimap.js';
import { SaveGame } from './systems/SaveGame.js';
import { SurvivalMode } from './systems/modes/SurvivalMode.js';
import { MiningMode } from './systems/modes/MiningMode.js';
import { formatTime } from './systems/modes/Mode.js';

const MODE_CLASSES = {
  survival: SurvivalMode,
  mining: MiningMode,
};

/**
 * Top-level orchestrator.
 *
 * Owns the loop, wires input intent to world actions, and holds UI-only state
 * (what is selected, what is queued for building). Deliberately the only place
 * that knows about all the pieces, so everything below it stays independent.
 */
export class Game {
  constructor(canvas, hudRoot) {
    this.canvas = canvas;
    this.hudRoot = hudRoot;

    this.assets = new Assets();
    this.camera = new Camera(canvas);
    this.input = new Input(canvas, this.camera);
    this.save = new SaveGame();

    this.world = null;
    this.renderer = null;
    this.hud = null;
    this.mode = null;

    this.buildKey = null;   // structure queued for placement
    this.selected = null;
    // Recycle mode: clicking sells outright and stays active, so tearing down
    // an obsolete run of relays is one click each rather than select-then-sell.
    this.sellMode = false;
    // Global launcher cut-off: missiles cost minerals, so silencing every bay at
    // once is the quickest way to stop bleeding income in a lull.
    this.launchersDisabled = false;
    this.speed = 1;
    // Must match the Hud's build-bar order: the number keys index into this.
    this.buildOrder = ['miner', 'solar', 'battery', 'relay',
                       'laser', 'pulser', 'missileBay', 'repair'];

    this.loop = new Loop(
      (dt) => this.update(dt),
      (alpha) => this.render(alpha)
    );
  }

  /** Load shared assets, then hand control to the menu. */
  async init() {
    this.data = await fetch('assets/entities.json').then((r) => {
      if (!r.ok) throw new Error(`entities.json: HTTP ${r.status}`);
      return r.json();
    });
    await this.assets.load('assets/sprites.svg');

    this.renderer = new Renderer(this.canvas, this.assets, this.camera);
    this._bindInput();
    this._bindResize();
    this._bindOverlay();
    this.renderer.resize();
    this._buildMenu();
    return this;
  }

  _bindOverlay() {
    // Bound once, rather than per run, so repeated games do not stack handlers.
    document.getElementById('again').addEventListener('click', () => {
      this.start(this.mode?.key ?? 'survival');
    });
    document.getElementById('tomenu').addEventListener('click', () => {
      document.getElementById('over').classList.remove('show');
      this.loop.setPaused(true);
      this._buildMenu();
    });
  }

  // -------------------------------------------------------------------- menu

  _buildMenu() {
    const menu = document.getElementById('menu');
    const list = menu.querySelector('#mode-list');
    list.innerHTML = '';

    for (const [key, cfg] of Object.entries(this.data.modes ?? {})) {
      if (!MODE_CLASSES[key]) continue; // 'missions' is not built yet
      const best = this.save.bestFor(key);
      const btn = document.createElement('button');
      btn.className = 'mode';
      btn.innerHTML = `
        <span class="mn">${key === 'survival' ? 'Survival' : 'Mining Race'}</span>
        <span class="md">${cfg.goal ?? ''}</span>
        <span class="mb">${best ? `Best: ${this._formatBest(best)}` : 'No record yet'}</span>
      `;
      btn.addEventListener('click', () => this.start(key));
      list.appendChild(btn);
    }
    menu.classList.add('show');
  }

  _formatBest(best) {
    if (!best) return '—';
    return best.metric === 'time' ? formatTime(best.value) : `wave ${best.value}`;
  }

  // ------------------------------------------------------------------- start

  start(modeKey) {
    document.getElementById('menu').classList.remove('show');
    document.getElementById('over').classList.remove('show');

    this.world = new World(this.data, Math.floor(Math.random() * 100000));
    const Cls = MODE_CLASSES[modeKey] ?? SurvivalMode;
    this.mode = new Cls(this.world, this.data.modes?.[modeKey] ?? {});

    this.hud = new Hud(this.hudRoot, this.world, this.data);
    this.hud.onBuildSelect = (key) => this.toggleBuild(key);
    this.hud.onSell = (s) => this.sell(s);
    this.hud.onCallWave = () => this.world.waves.callWaveNow();
    this.hud.onToggleRecycle = () => this.toggleSellMode();
    this.hud.onRecycleDead = () => this.recycleDeadMiners();
    this.hud.onSetSpeed = (m) => this.setSpeed(m);
    this.hud.onToggleDisabled = (s) => this.toggleDisabled(s);
    this.hud.onToggleAllLaunchers = () => this.toggleAllLaunchers();
    this.hud.onUpgrade = (s) => this.upgrade(s);

    // Rebuilt per run: the Hud recreates its DOM, so the old canvas is gone.
    this.minimap = new Minimap(
      document.getElementById('minimap'), this.world, this.camera
    );

    this.buildKey = null;
    this.selected = null;
    this.camera.centerOn(0, 0);
    this.camera.setBounds(-2400, -2400, 2400, 2400);

    this.loop.setPaused(false);
    document.body.classList.remove('paused');
    this.loop.start();
  }

  _bindResize() {
    const onResize = () => this.renderer.resize();
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(this.canvas);
  }

  _bindInput() {
    this.input.on('click', (world) => this.onClick(world));
    this.input.on('rightclick', () => this.cancel());
    this.input.on('key', (k) => this.onKey(k));
  }

  // ------------------------------------------------------------------- input

  onClick(worldPos) {
    if (!this.world || this.mode?.finished) return;
    if (this.buildKey) {
      this.tryPlace(worldPos.x, worldPos.y);
      return;
    }
    if (this.sellMode) {
      const hit = this.world.structureAt(worldPos.x, worldPos.y, 6);
      if (hit) this.sell(hit);
      return;
    }
    // Structures win ties, then asteroids — so clicking a miner sitting over a
    // rock selects the miner, which is nearly always what was meant.
    this.select(
      this.world.structureAt(worldPos.x, worldPos.y, 6) ||
      this.world.asteroidAt(worldPos.x, worldPos.y, 6)
    );
  }

  onKey(k) {
    if (!this.world) return;
    const n = parseInt(k, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= this.buildOrder.length) {
      this.toggleBuild(this.buildOrder[n - 1]);
      return;
    }
    if (k === 'escape') this.cancel();
    if (k === ' ') {
      const paused = this.loop.togglePause();
      document.body.classList.toggle('paused', paused);
    }
    if (k === 'g') this.renderer.showGrid = !this.renderer.showGrid;
    if (k === 'enter') this.world.waves.callWaveNow();
    if (k === 'delete' && this.selected) this.sell(this.selected);
    if (k === 'x') {
      // X sells the current selection, or arms recycle mode when nothing is
      // selected — so it works whichever way you reach for it.
      if (this.selected && this.selected.key) {
        this.sell(this.selected);
      } else {
        this.toggleSellMode();
      }
    }
  }

  setSpeed(mult) {
    this.speed = mult;
    this.loop.speed = mult;
    // Speeding up should never be a way to unpause.
    if (this.loop.paused) {
      this.loop.setPaused(false);
      document.body.classList.remove('paused');
    }
  }

  upgrade(s) {
    if (!s) return;
    // The same button cancels while work is in progress.
    if (s.upgrading) {
      s.cancelUpgrade(this.world.economy);
      this.flashText('Upgrade cancelled');
      return;
    }
    if (!s.canUpgrade) return;
    const u = s.nextUpgrade;
    if (!s.startUpgrade(this.world.economy)) {
      this.flashText('Not enough minerals');
      return;
    }
    this.flashText(`${u.name} started`);
  }

  toggleDisabled(s) {
    if (!s) return;
    s.disabled = !s.disabled;
  }

  toggleAllLaunchers() {
    this.launchersDisabled = !this.launchersDisabled;
    for (const s of this.world.structures) {
      if (s.alive && s.isLauncher) s.disabled = this.launchersDisabled;
    }
  }

  recycleDeadMiners() {
    const { count, refund } = this.world.recycleDeadMiners();
    this.flashText(count
      ? `Recycled ${count} exhausted miner${count === 1 ? '' : 's'} · +${refund}`
      : 'No exhausted miners to recycle');
  }

  toggleSellMode() {
    this.sellMode = !this.sellMode;
    if (this.sellMode) {
      this.buildKey = null;
      this.hud?.setActiveBuild(null);
      this.select(null);
    }
    document.body.classList.toggle('selling', this.sellMode);
  }

  toggleBuild(key) {
    this.buildKey = this.buildKey === key ? null : key;
    this.hud?.setActiveBuild(this.buildKey);
    if (this.buildKey) this.select(null);
  }

  cancel() {
    if (this.sellMode) {
      this.toggleSellMode();
    } else if (this.buildKey) {
      this.buildKey = null;
      this.hud?.setActiveBuild(null);
    } else {
      this.select(null);
    }
  }

  select(s) {
    if (this.selected) this.selected.selected = false;
    this.selected = s || null;
    if (this.selected) this.selected.selected = true;
  }

  tryPlace(x, y) {
    const check = this.world.canPlaceAt(this.buildKey, x, y);
    if (!check.ok) {
      this.flash(check.reason);
      return;
    }
    if (!this.world.placeStructure(this.buildKey, x, y)) {
      this.flash('minerals');
      return;
    }
    // Shift keeps the tool active for laying out several in a row.
    if (!this.input.isDown('shift')) this.cancel();
  }

  sell(s) {
    if (!s) return;
    if (this.world.liveStructures.length <= 1) {
      this.flashText('Cannot sell your last structure');
      return;
    }
    if (this.selected === s) this.select(null);
    this.world.sellStructure(s);
  }

  flash(reason) {
    const msg = {
      minerals: 'Not enough minerals',
      blocked: 'Too close to another structure',
      asteroid: 'Cannot build on an asteroid',
      range: 'Outside the operating area',
    }[reason] || 'Cannot build there';
    this.flashText(msg);
  }

  /** Transient message in the warning strip. */
  flashText(msg) {
    const warn = this.hudRoot?.querySelector('#warn');
    if (!warn) return;
    warn.querySelector('.err')?.remove();
    warn.insertAdjacentHTML('afterbegin', `<div class="w err">${msg}</div>`);
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => warn.querySelector('.err')?.remove(), 1800);
  }

  // -------------------------------------------------------------------- over

  _endRun() {
    const over = document.getElementById('over');
    if (over.classList.contains('show')) return;

    const won = this.mode.state === 'won';
    const isBest = this.save.recordScore(this.mode.key, this.mode.score());
    const best = this.save.bestFor(this.mode.key);

    over.querySelector('#over-title').textContent = won ? 'Quota met' : 'Run over';
    over.querySelector('#over-title').className = won ? 'win' : '';
    over.querySelector('#over-reason').textContent = this.mode.reason;
    over.querySelector('#over-rows').innerHTML = this.mode
      .summary()
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
      .join('');
    over.querySelector('#over-best').innerHTML = best
      ? `${isBest ? '<em>New personal best!</em> ' : ''}Best: <b>${this._formatBest(best)}</b>`
      : '';

    over.classList.add('show');
    this.loop.setPaused(true);
  }

  update(dt) {
    if (!this.world) return;
    this.input.applyKeyboardPan(dt);
    this.camera.update(dt);
    this.world.update(dt);
    this.mode.update(dt);
    if (this.selected && !this.selected.alive) this.select(null);
    this.hud.update(this);
    if (this.mode.finished) this._endRun();
  }

  render() {
    if (!this.world) return;
    this.renderer.render(this.world, {
      buildKey: this.buildKey,
      sellMode: this.sellMode,
      pointer: this.input.overCanvas ? this.input.world : null,
    });
    this.minimap?.render();
  }
}
