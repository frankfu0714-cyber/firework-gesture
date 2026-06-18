// 幫你放煙火 · Wave to Spark Fireworks
// Canvas 2D fireworks + MediaPipe Hands gesture tracking + WebAudio synthesis.

(() => {
  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const video = document.getElementById('video');
  const messageEl = document.getElementById('message');
  const hintEl = document.getElementById('hint');

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || W < 720;
  hintEl.textContent = isMobile ? hintEl.dataset.mobile : hintEl.dataset.desktop;

  // -------------------------------------------------------------------------
  // Palette — auspicious Lunar New Year colors
  // -------------------------------------------------------------------------
  const PALETTE = [
    { r: 212, g: 0,   b: 0   }, // deep red
    { r: 255, g: 200, b: 87  }, // gold
    { r: 255, g: 107, b: 53  }, // orange
    { r: 255, g: 71,  b: 126 }, // pink
  ];

  // Ember palette used by detonations — mostly orange + deep red, occasional
  // yellow highlight. Drives a "real fire" look rather than rainbow sparks.
  const EMBER_PALETTE = [
    { r: 255, g: 222, b: 110, weight: 0.10 }, // yellow highlight
    { r: 255, g: 175, b:  80, weight: 0.32 }, // bright orange
    { r: 255, g: 107, b:  53, weight: 0.32 }, // base orange
    { r: 220, g:  70, b:  30, weight: 0.20 }, // red-orange
    { r: 212, g:   0, b:   0, weight: 0.06 }, // deep red
  ];
  function pickEmber() {
    const r = Math.random();
    let acc = 0;
    for (const c of EMBER_PALETTE) {
      acc += c.weight;
      if (r < acc) return c;
    }
    return EMBER_PALETTE[2];
  }
  function paletteAt(t) {
    const len = PALETTE.length;
    const f = ((t % 1) + 1) % 1 * len;
    const i = Math.floor(f);
    const k = f - i;
    const a = PALETTE[i];
    const b = PALETTE[(i + 1) % len];
    return {
      r: a.r + (b.r - a.r) * k,
      g: a.g + (b.g - a.g) * k,
      b: a.b + (b.b - a.b) * k,
    };
  }
  const rgba = (c, a) => `rgba(${c.r|0},${c.g|0},${c.b|0},${a})`;

  // -------------------------------------------------------------------------
  // Stars
  // -------------------------------------------------------------------------
  const stars = [];
  function buildStars() {
    stars.length = 0;
    const count = Math.floor((W * H) / 8000);
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.3 + 0.25,
        twinkle: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.012 + 0.003,
        drift: (Math.random() - 0.5) * 0.04,
      });
    }
  }
  buildStars();
  window.addEventListener('resize', buildStars);

  // -------------------------------------------------------------------------
  // Seeds — falling fireworks waiting to detonate
  // -------------------------------------------------------------------------
  const seeds = [];

  class Seed {
    constructor() {
      this.x = 30 + Math.random() * (W - 60);
      this.y = -20 - Math.random() * 80;
      this.vy = 18 + Math.random() * 24; // 18-42 px/s
      this.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      this.r = 8 + Math.random() * 4; // core radius 8-12 → ball diameter 16-24
      this.phase = Math.random() * Math.PI * 2;
      this.swayAmp = 6 + Math.random() * 14;
      this.swayFreq = 0.4 + Math.random() * 0.5;
      this.t0 = performance.now() * 0.001;
      this.alive = true;
    }
    update(dt, now) {
      this.y += this.vy * dt;
      // gentle horizontal sway (in addition to base position drift)
      this.x += Math.cos((now - this.t0) * this.swayFreq + this.phase) * this.swayAmp * dt;
      if (this.y > H + 40 || this.x < -40 || this.x > W + 40) this.alive = false;
    }
    draw(now) {
      const t = now - this.t0;
      const pulse = 0.88 + 0.12 * Math.sin(t * 3 + this.phase);
      const r = this.r * (0.96 + 0.06 * pulse);
      const c = this.color;
      const x = this.x, y = this.y;

      // Soft cast shadow beneath the ball (flattened ellipse, normal alpha)
      const sy = y + r * 0.7;
      const sg = ctx.createRadialGradient(x, sy, 0, x, sy, r * 1.45);
      sg.addColorStop(0, 'rgba(0, 0, 0, 0.32)');
      sg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.ellipse(x, sy, r * 1.45, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Warm outer halo (additive so colors stack with sky)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const haloR = r * 2.6;
      const hg = ctx.createRadialGradient(x, y, r * 0.7, x, y, haloR);
      hg.addColorStop(0,   rgba(c, 0.55 * pulse));
      hg.addColorStop(0.4, rgba(c, 0.22 * pulse));
      hg.addColorStop(1,   rgba(c, 0));
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(x, y, haloR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Sphere body — radial gradient centered up-left for 3D shading
      const lightX = x - r * 0.42;
      const lightY = y - r * 0.42;
      const dark   = { r: c.r * 0.22, g: c.g * 0.22, b: c.b * 0.22 };
      const bright = {
        r: Math.min(255, c.r + 100),
        g: Math.min(255, c.g + 100),
        b: Math.min(255, c.b + 100),
      };
      const bg = ctx.createRadialGradient(lightX, lightY, 0, x, y, r * 1.18);
      bg.addColorStop(0,    'rgba(255, 252, 230, 1)');
      bg.addColorStop(0.15, rgba(bright, 1));
      bg.addColorStop(0.6,  rgba(c, 1));
      bg.addColorStop(1,    rgba(dark, 1));
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Specular highlight near the light source
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const spx = x - r * 0.42, spy = y - r * 0.48;
      const spR = r * 0.42;
      const sph = ctx.createRadialGradient(spx, spy, 0, spx, spy, spR);
      sph.addColorStop(0,   `rgba(255, 255, 255, ${0.9 * pulse})`);
      sph.addColorStop(0.5, `rgba(255, 255, 255, ${0.35 * pulse})`);
      sph.addColorStop(1,   'rgba(255, 255, 255, 0)');
      ctx.fillStyle = sph;
      ctx.beginPath();
      ctx.arc(spx, spy, spR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function spawnSeeds(dt) {
    // Target rate: ~2-3 seeds per second, capped at 28 simultaneous.
    const rate = 2.4;
    if (seeds.length < 28 && Math.random() < rate * dt) {
      seeds.push(new Seed());
    }
  }

  // -------------------------------------------------------------------------
  // Particle system (object-pooled sparks)
  // -------------------------------------------------------------------------
  const MAX_PARTICLES = 600;
  const particlePool = [];
  const particles = [];

  function getParticle() {
    return particlePool.pop() || {};
  }
  function releaseParticle(p) {
    if (particlePool.length < 1200) particlePool.push(p);
  }

  function explode(x, y /* color unused — fireballs are always ember */) {
    const count = 90 + Math.floor(Math.random() * 50); // 90-140
    const room = MAX_PARTICLES - particles.length;
    const n = Math.min(count, room);

    for (let i = 0; i < n; i++) {
      // Roughly spherical fan-out with a little angular jitter
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.35;
      const sp = Math.pow(Math.random(), 0.55);
      const speed = 110 + sp * 320; // heavier punch than the original
      const ember = pickEmber();
      const p = getParticle();
      p.x = x; p.y = y;
      p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = clamp(ember.r + (Math.random() - 0.5) * 25, 80, 255);
      p.g = clamp(ember.g + (Math.random() - 0.5) * 22, 20, 255);
      p.b = clamp(ember.b + (Math.random() - 0.5) * 20, 0,  200);
      p.life = 1.0;
      p.maxLife = 0.95 + Math.random() * 0.7;
      p.size = 1.4 + Math.random() * 2.0;
      p.drag = 0.978 + Math.random() * 0.012;
      p.glow = 0.5 + Math.random() * 0.4;
      particles.push(p);
    }

    spawnSmoke(x, y);
    spawnFlash();
    playExplosion();

    // Occasional 福/春 drift after explosion
    if (Math.random() < 0.32) spawnChars(x, y);
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.trailX = p.x;
      p.trailY = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 220 * dt;     // gravity
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.life -= dt / p.maxLife;
      if (p.life <= 0) {
        releaseParticle(p);
        particles.splice(i, 1);
      }
    }
  }

  function drawParticles() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const a = Math.max(0, p.life);
      const fade = a * a; // ease out
      // streak / trail
      ctx.strokeStyle = `rgba(${p.r|0},${p.g|0},${p.b|0},${fade * 0.6})`;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.trailX, p.trailY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      // bright head
      const sz = p.size * (1.2 + fade * 0.6);
      ctx.fillStyle = `rgba(${p.r|0},${p.g|0},${p.b|0},${fade})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
      ctx.fill();
      // halo
      const haloR = sz * 4 * p.glow;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
      grad.addColorStop(0, `rgba(${p.r|0},${p.g|0},${p.b|0},${fade * 0.5})`);
      grad.addColorStop(1, `rgba(${p.r|0},${p.g|0},${p.b|0},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Smoke puffs — translucent gray clouds that linger after a detonation
  // -------------------------------------------------------------------------
  const smoke = [];
  function spawnSmoke(x, y) {
    const n = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      smoke.push({
        x: x + (Math.random() - 0.5) * 24,
        y: y + (Math.random() - 0.5) * 16,
        vx: (Math.random() - 0.5) * 22,
        vy: -22 - Math.random() * 24,
        life: 1,
        maxLife: 1.3 + Math.random() * 0.5,
        r: 14 + Math.random() * 14,
        growth: 14 + Math.random() * 20,
        tint: 60 + Math.floor(Math.random() * 30),
      });
    }
  }
  function updateSmoke(dt) {
    for (let i = smoke.length - 1; i >= 0; i--) {
      const s = smoke[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 5 * dt; // a tiny pull so smoke slows its rise
      s.vx *= 0.96;
      s.r += s.growth * dt;
      s.life -= dt / s.maxLife;
      if (s.life <= 0) smoke.splice(i, 1);
    }
  }
  function drawSmoke() {
    for (let i = 0; i < smoke.length; i++) {
      const s = smoke[i];
      const a = Math.min(1, s.life * 1.4) * 0.32;
      const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
      grad.addColorStop(0,   `rgba(${s.tint},${s.tint},${s.tint + 6},${a})`);
      grad.addColorStop(0.55,`rgba(${s.tint},${s.tint},${s.tint + 6},${a * 0.45})`);
      grad.addColorStop(1,   `rgba(${s.tint},${s.tint},${s.tint + 6},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // -------------------------------------------------------------------------
  // Detonation flash — full-screen overlay, hot white → yellow → orange → red
  // -------------------------------------------------------------------------
  const flashes = [];
  const FLASH_DURATION = 0.28;
  function spawnFlash() {
    flashes.push({ t: 0 });
    if (flashes.length > 6) flashes.shift();
  }
  function drawFlash(dt) {
    if (flashes.length === 0) return;
    let aggR = 0, aggG = 0, aggB = 0, aggA = 0;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t += dt;
      if (f.t >= FLASH_DURATION) { flashes.splice(i, 1); continue; }
      const t = f.t / FLASH_DURATION;
      const a = Math.pow(1 - t, 1.5) * 0.5;
      let r, g, b;
      if (t < 0.16) {
        // hot white → yellow
        const k = t / 0.16;
        r = 255; g = 255 - k * 40; b = 245 - k * 200;
      } else if (t < 0.5) {
        // yellow → orange
        const k = (t - 0.16) / 0.34;
        r = 255; g = 215 - k * 100; b = 45 - k * 15;
      } else {
        // orange → deep red
        const k = (t - 0.5) / 0.5;
        r = 255 - k * 55; g = 115 - k * 110; b = 30 - k * 30;
      }
      aggR += r * a; aggG += g * a; aggB += b * a; aggA += a;
    }
    if (aggA <= 0) return;
    const cap = Math.min(0.55, aggA);
    ctx.fillStyle = `rgba(${(aggR/aggA)|0},${(aggG/aggA)|0},${(aggB/aggA)|0},${cap})`;
    ctx.fillRect(0, 0, W, H);
  }

  // -------------------------------------------------------------------------
  // Floating lanterns (background flourish)
  // -------------------------------------------------------------------------
  const lanterns = [];
  class Lantern {
    constructor(rightToLeft = false) {
      this.y = 80 + Math.random() * (H - 240);
      this.scale = 0.7 + Math.random() * 0.6;
      this.dir = rightToLeft ? -1 : 1;
      this.x = this.dir > 0 ? -60 : W + 60;
      this.vx = (4 + Math.random() * 6) * this.dir;
      this.bob = Math.random() * Math.PI * 2;
    }
    update(dt) {
      this.x += this.vx * dt;
      this.bob += dt * 0.6;
      if ((this.dir > 0 && this.x > W + 80) || (this.dir < 0 && this.x < -80)) this.dead = true;
    }
    draw() {
      const y = this.y + Math.sin(this.bob) * 6;
      const s = this.scale;
      ctx.save();
      ctx.globalAlpha = 0.38;
      // lantern glow
      const halo = ctx.createRadialGradient(this.x, y, 0, this.x, y, 60 * s);
      halo.addColorStop(0, 'rgba(255, 130, 80, 0.45)');
      halo.addColorStop(1, 'rgba(120, 20, 20, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(this.x, y, 60 * s, 0, Math.PI * 2);
      ctx.fill();
      // lantern body (elongated ellipse, dark warm red)
      ctx.fillStyle = 'rgba(180, 35, 30, 0.85)';
      ctx.beginPath();
      ctx.ellipse(this.x, y, 18 * s, 24 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // top & bottom caps
      ctx.fillStyle = 'rgba(80, 25, 15, 0.9)';
      ctx.fillRect(this.x - 9 * s, y - 26 * s, 18 * s, 3 * s);
      ctx.fillRect(this.x - 9 * s, y + 23 * s, 18 * s, 3 * s);
      // tassel
      ctx.strokeStyle = 'rgba(255, 200, 87, 0.7)';
      ctx.lineWidth = 1.2 * s;
      ctx.beginPath();
      ctx.moveTo(this.x, y + 26 * s);
      ctx.lineTo(this.x, y + 44 * s);
      ctx.stroke();
      // tassel tuft
      ctx.fillStyle = 'rgba(255, 200, 87, 0.8)';
      ctx.beginPath();
      ctx.arc(this.x, y + 46 * s, 2.4 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  function spawnLantern() {
    if (lanterns.length < 4 && Math.random() < 0.0035) {
      lanterns.push(new Lantern(Math.random() < 0.5));
    }
  }

  // -------------------------------------------------------------------------
  // 福 / 春 chars rising after big bursts
  // -------------------------------------------------------------------------
  const chars = [];
  class CharParticle {
    constructor(x, y) {
      this.x = x + (Math.random() - 0.5) * 30;
      this.y = y;
      this.vy = -40 - Math.random() * 30;
      this.vx = (Math.random() - 0.5) * 24;
      this.life = 1;
      this.maxLife = 2.4 + Math.random() * 0.8;
      this.char = Math.random() < 0.5 ? '福' : '春';
      this.size = 22 + Math.random() * 14;
      this.rot = (Math.random() - 0.5) * 0.4;
    }
    update(dt) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vy += 6 * dt;
      this.vx *= 0.985;
      this.life -= dt / this.maxLife;
    }
    draw() {
      if (this.life <= 0) return;
      ctx.save();
      const a = Math.min(1, this.life * 1.6);
      ctx.globalAlpha = a;
      ctx.translate(this.x, this.y);
      ctx.rotate(this.rot);
      ctx.font = `700 ${this.size}px "PingFang TC", "Microsoft JhengHei", "Hiragino Sans GB", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(255, 107, 53, 0.85)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#ffd86b';
      ctx.fillText(this.char, 0, 0);
      ctx.restore();
    }
  }
  function spawnChars(x, y) {
    if (chars.length > 24) return;
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) chars.push(new CharParticle(x, y - 18));
  }

  // -------------------------------------------------------------------------
  // Audio — synthesized boom + crackle
  // -------------------------------------------------------------------------
  let audioCtx = null, masterGain = null;
  function ensureAudio() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.55;
        // Light compression to keep peaks tame even on overlapping bursts.
        const comp = audioCtx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 8;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        masterGain.connect(comp);
        comp.connect(audioCtx.destination);
      } catch (e) {
        audioCtx = null;
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
    window.addEventListener(ev, ensureAudio, { passive: true })
  );

  function playExplosion() {
    if (!audioCtx) return;
    const ac = audioCtx;
    const now = ac.currentTime;

    // 1) Transient — high-passed noise click for instant attack
    const tDur = 0.025;
    const tBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * tDur), ac.sampleRate);
    const tData = tBuf.getChannelData(0);
    for (let i = 0; i < tData.length; i++) {
      tData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / tData.length, 2.5);
    }
    const trans = ac.createBufferSource();
    trans.buffer = tBuf;
    const tFilt = ac.createBiquadFilter();
    tFilt.type = 'highpass';
    tFilt.frequency.value = 600;
    const tGain = ac.createGain();
    tGain.gain.value = 0.55;
    trans.connect(tFilt); tFilt.connect(tGain); tGain.connect(masterGain);
    trans.start(now);

    // 2) Body — sine 85→26 Hz with razor-sharp attack
    const body = ac.createOscillator();
    const bodyGain = ac.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(85 + Math.random() * 12, now);
    body.frequency.exponentialRampToValueAtTime(26, now + 0.32);
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(1.0, now + 0.004); // ~4ms attack
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    body.connect(bodyGain); bodyGain.connect(masterGain);
    body.start(now);
    body.stop(now + 0.46);

    // 3) Sub — sine 42→16 Hz, the chest-thump octave below the body
    const sub = ac.createOscillator();
    const subGain = ac.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(42, now);
    sub.frequency.exponentialRampToValueAtTime(16, now + 0.28);
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime(0.7, now + 0.006);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
    sub.connect(subGain); subGain.connect(masterGain);
    sub.start(now);
    sub.stop(now + 0.38);

    // 4) Low rumble — lowpassed noise to fill out the tail of the boom
    const rDur = 0.55;
    const rBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * rDur), ac.sampleRate);
    const rData = rBuf.getChannelData(0);
    for (let i = 0; i < rData.length; i++) {
      rData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rData.length, 1.2);
    }
    const rum = ac.createBufferSource();
    rum.buffer = rBuf;
    const rFilt = ac.createBiquadFilter();
    rFilt.type = 'lowpass';
    rFilt.frequency.value = 180;
    rFilt.Q.value = 0.7;
    const rGain = ac.createGain();
    rGain.gain.setValueAtTime(0.0001, now);
    rGain.gain.exponentialRampToValueAtTime(0.32, now + 0.01);
    rGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    rum.connect(rFilt); rFilt.connect(rGain); rGain.connect(masterGain);
    rum.start(now);

    // 5) Crackle — secondary, quieter than before so the boom dominates
    const cDur = 0.32;
    const cBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * cDur), ac.sampleRate);
    const cData = cBuf.getChannelData(0);
    for (let i = 0; i < cData.length; i++) {
      const env = Math.pow(1 - i / cData.length, 1.6);
      const spike = Math.random() < 0.05 ? 1.6 : 1.0;
      cData[i] = (Math.random() * 2 - 1) * env * spike;
    }
    const crack = ac.createBufferSource();
    crack.buffer = cBuf;
    const cFilt = ac.createBiquadFilter();
    cFilt.type = 'bandpass';
    cFilt.frequency.value = 1500 + Math.random() * 1200;
    cFilt.Q.value = 1.0;
    const cGain = ac.createGain();
    const cStart = now + 0.05;
    cGain.gain.setValueAtTime(0.0001, cStart);
    cGain.gain.linearRampToValueAtTime(0.18, cStart + 0.02);
    cGain.gain.exponentialRampToValueAtTime(0.001, cStart + 0.3);
    crack.connect(cFilt); cFilt.connect(cGain); cGain.connect(masterGain);
    crack.start(cStart);
    crack.stop(cStart + 0.34);
  }

  // -------------------------------------------------------------------------
  // Hand cursor — driven by MediaPipe Hands or fallback (mouse / touch)
  // -------------------------------------------------------------------------
  const hand = {
    x: -1000, y: -1000,
    prevX: -1000, prevY: -1000,
    active: false,
    lastUpdate: 0,
  };
  const cursorTrail = []; // ring buffer of recent positions {x,y,t}

  function setHandPos(x, y) {
    hand.prevX = hand.active ? hand.x : x;
    hand.prevY = hand.active ? hand.y : y;
    hand.x = x;
    hand.y = y;
    hand.active = true;
    hand.lastUpdate = performance.now();
    cursorTrail.push({ x, y, t: hand.lastUpdate });
    if (cursorTrail.length > 14) cursorTrail.shift();
  }

  function drawCursor(now) {
    // fade cursor if no recent input
    const sinceUpdate = now - hand.lastUpdate;
    if (!hand.active || sinceUpdate > 1200) return;
    const fade = Math.max(0, 1 - sinceUpdate / 1200);

    // current palette-cycling color
    const c = paletteAt(now * 0.00012);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // motion-blur trail
    for (let i = 0; i < cursorTrail.length; i++) {
      const t = cursorTrail[i];
      const age = (now - t.t) / 350;
      if (age >= 1) continue;
      const a = (1 - age) * 0.32 * fade;
      const r = 38 * (1 - age * 0.4);
      const grad = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, r);
      grad.addColorStop(0, rgba(c, a));
      grad.addColorStop(0.5, rgba(c, a * 0.5));
      grad.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // bright wisp at hand position
    const coreR = 56;
    const grad = ctx.createRadialGradient(hand.x, hand.y, 0, hand.x, hand.y, coreR);
    grad.addColorStop(0,   `rgba(255,255,255,${0.85 * fade})`);
    grad.addColorStop(0.15, rgba(c, 0.75 * fade));
    grad.addColorStop(0.55, rgba(c, 0.25 * fade));
    grad.addColorStop(1,   rgba(c, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, coreR, 0, Math.PI * 2);
    ctx.fill();

    // pulsing inner pip
    const pip = 4 + 1.5 * Math.sin(now * 0.012);
    ctx.fillStyle = `rgba(255, 255, 255, ${0.95 * fade})`;
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, pip, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Collision: swept-segment from hand.prev → hand.current vs seeds
  // -------------------------------------------------------------------------
  function distSegPoint(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-4) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  const COLLISION_RADIUS = 44;
  function checkCollisions(now) {
    if (!hand.active) return;
    if (now - hand.lastUpdate > 600) return;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      if (!s.alive) continue;
      const d = distSegPoint(hand.prevX, hand.prevY, hand.x, hand.y, s.x, s.y);
      if (d < COLLISION_RADIUS + s.r) {
        s.alive = false;
        explode(s.x, s.y, s.color);
      }
    }
  }

  // -------------------------------------------------------------------------
  // MediaPipe Hands setup (desktop)
  // -------------------------------------------------------------------------
  let mpReady = false;
  async function initHandTracking() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
    } catch (e) {
      console.warn('Webcam denied:', e);
      messageEl.classList.add('show');
      video.style.display = 'none';
      return;
    }
    video.srcObject = stream;
    await new Promise(r => {
      if (video.readyState >= 2) r();
      else video.onloadedmetadata = () => r();
    });
    await video.play().catch(() => {});

    if (typeof Hands === 'undefined') {
      console.warn('MediaPipe Hands not loaded; falling back to mouse.');
      return;
    }

    const hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
    });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(onHandResults);

    let sending = false;
    const tick = async () => {
      if (!sending && video.readyState >= 2) {
        sending = true;
        try { await hands.send({ image: video }); }
        catch (e) { /* swallow transient errors */ }
        sending = false;
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  function onHandResults(results) {
    mpReady = true;
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      // palm centroid: wrist + base of fingers
      const lm = results.multiHandLandmarks[0];
      const idxs = [0, 5, 9, 13, 17];
      let nx = 0, ny = 0;
      for (const i of idxs) { nx += lm[i].x; ny += lm[i].y; }
      nx /= idxs.length; ny /= idxs.length;
      // camera is mirrored visually; flip x so right hand → right side
      const sx = (1 - nx) * W;
      const sy = ny * H;
      setHandPos(sx, sy);
      video.classList.remove('idle');
    } else {
      hand.active = false;
      video.classList.add('idle');
    }
  }

  // -------------------------------------------------------------------------
  // Fallbacks: mouse on desktop (until MediaPipe takes over), tap on mobile
  // -------------------------------------------------------------------------
  function explodeNearest(x, y, radius = 110) {
    let nearest = null, nd = radius;
    for (const s of seeds) {
      if (!s.alive) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < nd) { nd = d; nearest = s; }
    }
    if (nearest) {
      nearest.alive = false;
      explode(nearest.x, nearest.y, nearest.color);
    } else {
      // no seed nearby: paint a small burst so taps always feel alive
      explode(x, y, PALETTE[Math.floor(Math.random() * PALETTE.length)]);
    }
  }

  if (isMobile) {
    video.style.display = 'none';
    const onTouch = (e) => {
      ensureAudio();
      const t = e.touches ? e.touches[0] : e;
      if (!t) return;
      setHandPos(t.clientX, t.clientY);
      explodeNearest(t.clientX, t.clientY);
    };
    window.addEventListener('pointerdown', onTouch, { passive: true });
    window.addEventListener('pointermove', (e) => {
      if (e.pressure > 0 || e.buttons > 0) {
        setHandPos(e.clientX, e.clientY);
      }
    }, { passive: true });
  } else {
    // mouse mirrors hand if MediaPipe has not produced results yet (or hasn't recently)
    window.addEventListener('mousemove', (e) => {
      if (performance.now() - hand.lastUpdate > 400) {
        setHandPos(e.clientX, e.clientY);
      }
    });
    window.addEventListener('mousedown', () => ensureAudio());
    initHandTracking();
  }

  // -------------------------------------------------------------------------
  // Background rendering
  // -------------------------------------------------------------------------
  // Pre-cache the gradient since W/H rarely change
  let bgGradient = null;
  function rebuildBgGradient() {
    bgGradient = ctx.createLinearGradient(0, 0, 0, H);
    bgGradient.addColorStop(0,    '#0a0e2a');
    bgGradient.addColorStop(0.55, '#141039');
    bgGradient.addColorStop(1,    '#1a1240');
  }
  rebuildBgGradient();
  window.addEventListener('resize', rebuildBgGradient);

  function drawBackground(now) {
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, W, H);

    // stars
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.twinkle += s.speed;
      s.x += s.drift;
      if (s.x < -2) s.x = W + 2;
      else if (s.x > W + 2) s.x = -2;
      const a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(s.twinkle));
      ctx.fillStyle = `rgba(255, 245, 220, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // subtle horizon glow at bottom
    const horizon = ctx.createLinearGradient(0, H * 0.6, 0, H);
    horizon.addColorStop(0, 'rgba(255, 107, 53, 0)');
    horizon.addColorStop(1, 'rgba(255, 107, 53, 0.06)');
    ctx.fillStyle = horizon;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------
  let lastTime = performance.now();

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function frame(now) {
    const dt = Math.min(0.06, (now - lastTime) / 1000);
    lastTime = now;

    // spawn
    spawnSeeds(dt);
    spawnLantern();

    // update
    for (let i = 0; i < seeds.length; i++) seeds[i].update(dt, now * 0.001);
    for (let i = seeds.length - 1; i >= 0; i--) if (!seeds[i].alive) seeds.splice(i, 1);

    for (const l of lanterns) l.update(dt);
    for (let i = lanterns.length - 1; i >= 0; i--) if (lanterns[i].dead) lanterns.splice(i, 1);

    updateParticles(dt);
    updateSmoke(dt);

    for (const c of chars) c.update(dt);
    for (let i = chars.length - 1; i >= 0; i--) if (chars[i].life <= 0) chars.splice(i, 1);

    checkCollisions(now);

    // draw
    drawBackground(now);
    for (const l of lanterns) l.draw();
    for (const s of seeds) s.draw(now * 0.001);
    drawSmoke();        // smoke sits behind the bright embers
    drawParticles();
    drawCursor(now);
    for (const c of chars) c.draw();
    drawFlash(dt);      // hot white → yellow → orange → red

    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { lastTime = t; frame(t); });

  // -------------------------------------------------------------------------
  // Pre-seed a couple of welcoming bursts so the first thing visitors see is
  // a sky that's already alive.
  // -------------------------------------------------------------------------
  setTimeout(() => {
    explode(W * 0.3, H * 0.4, PALETTE[1]);
  }, 700);
  setTimeout(() => {
    explode(W * 0.72, H * 0.55, PALETTE[3]);
  }, 1500);
  setTimeout(() => {
    explode(W * 0.5, H * 0.35, PALETTE[2]);
  }, 2400);

})();
