// 幫你放煙火 · Wave to Spark Fireworks
// Canvas 2D fireworks + MediaPipe Hands whole-hand collision + WebAudio.
//
// Layering (back → front):
//   <video>  fullscreen webcam, mirrored                       z-index 0
//   <canvas> translucent night-sky overlay + fireworks         z-index 1
//   title / hint / message DOM overlays                       z-index 10+
//
// Collision: convex hull of all 21 hand landmarks per detected hand. Any
// seed whose center lies inside the (slightly inflated) hull detonates.

(() => {
  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d'); // alpha=true (default) so webcam shows
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
  // Color palettes
  // -------------------------------------------------------------------------
  const PALETTE = [
    { r: 212, g: 0,   b: 0   }, // deep red
    { r: 255, g: 200, b: 87  }, // gold
    { r: 255, g: 107, b: 53  }, // orange
    { r: 255, g: 71,  b: 126 }, // pink
  ];
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

  // Per-style firework palettes (selected by spawn* functions).
  const PAL_REDGOLD = [
    { r: 212, g:   0, b:   0 }, // red
    { r: 255, g: 200, b:  87 }, // gold
    { r: 255, g: 165, b:  80 },
    { r: 255, g:  71, b: 126 }, // pink
    { r: 230, g:  50, b:  90 },
  ];
  const PAL_GOLD = [
    { r: 255, g: 200, b:  87 },
    { r: 255, g: 220, b: 130 },
    { r: 230, g: 165, b:  60 },
    { r: 255, g: 175, b:  70 },
  ];
  const PAL_MULTI = [
    { r: 212, g:   0, b:   0 },
    { r: 255, g: 200, b:  87 },
    { r: 255, g: 107, b:  53 },
    { r: 255, g:  71, b: 126 },
    { r: 100, g: 180, b: 255 },
    { r: 180, g: 100, b: 255 },
    { r: 100, g: 230, b: 130 },
  ];
  const PAL_ORANGERED = [
    { r: 255, g: 107, b:  53 },
    { r: 220, g:  70, b:  30 },
    { r: 212, g:   0, b:   0 },
    { r: 255, g: 165, b:  80 },
  ];

  function pickFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function jitter(c, amount) {
    return {
      r: clamp(c.r + (Math.random() - 0.5) * amount, 30, 255),
      g: clamp(c.g + (Math.random() - 0.5) * amount, 20, 255),
      b: clamp(c.b + (Math.random() - 0.5) * amount, 0,  255),
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // -------------------------------------------------------------------------
  // Stars (subtle twinkle through the night-sky overlay)
  // -------------------------------------------------------------------------
  const stars = [];
  function buildStars() {
    stars.length = 0;
    const count = Math.floor((W * H) / 12000);
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
  // Falling firework balls (Seeds)
  // -------------------------------------------------------------------------
  const seeds = [];

  class Seed {
    constructor(opts) {
      const huge = !!(opts && opts.huge);
      this.huge = huge;
      if (opts) {
        this.x = opts.x;
        this.y = opts.y;
        this.initialVx = opts.vx || 0;
        this.initialVy = opts.vy || 0;
      } else {
        this.x = 30 + Math.random() * (W - 60);
        this.y = -20 - Math.random() * 80;
        this.initialVx = 0;
        this.initialVy = 0;
      }
      // Huge balls fall slower and barely sway (they're "heavier").
      this.targetVy = huge ? 11 + Math.random() * 6 : 18 + Math.random() * 24;
      this.color = huge
        ? { r: 255, g: 210, b: 100 } // warm gold
        : PALETTE[Math.floor(Math.random() * PALETTE.length)];
      this.r = huge ? 30 + Math.random() * 10 : 8 + Math.random() * 4;
      this.phase = Math.random() * Math.PI * 2;
      this.swayAmp = huge ? 3 + Math.random() * 3 : 6 + Math.random() * 14;
      this.swayFreq = 0.4 + Math.random() * 0.5;
      this.t0 = performance.now() * 0.001;
      this.haloRotation = Math.random() * Math.PI * 2;
      this.alive = true;
    }
    update(dt, now) {
      // Decay any fling velocity (from a pinch-spawn) so the ball settles
      // into the gentle terminal fall over roughly a second.
      if (this.initialVx !== 0 || this.initialVy !== 0) {
        const decay = Math.pow(0.15, dt);
        this.initialVx *= decay;
        this.initialVy *= decay;
        if (Math.abs(this.initialVx) < 0.3) this.initialVx = 0;
        if (Math.abs(this.initialVy) < 0.3) this.initialVy = 0;
      }
      this.y += (this.initialVy + this.targetVy) * dt;
      this.x += this.initialVx * dt;
      this.x += Math.cos((now - this.t0) * this.swayFreq + this.phase) * this.swayAmp * dt;
      // Huge balls rotate their halo at ~0.7 rad/s (one turn per ~9s)
      if (this.huge) this.haloRotation += dt * 0.7;
      if (this.y > H + 40 || this.x < -40 || this.x > W + 40) this.alive = false;
    }
    draw(now) {
      const t = now - this.t0;
      const pulse = 0.88 + 0.12 * Math.sin(t * 3 + this.phase);
      const r = this.r * (0.96 + 0.06 * pulse);
      const c = this.color;
      const x = this.x, y = this.y;

      // Cast shadow beneath
      const sy = y + r * 0.7;
      const sg = ctx.createRadialGradient(x, sy, 0, x, sy, r * 1.45);
      sg.addColorStop(0, 'rgba(0, 0, 0, 0.32)');
      sg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.ellipse(x, sy, r * 1.45, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Warm outer halo (additive)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const haloR = r * (this.huge ? 3.2 : 2.6);
      const hg = ctx.createRadialGradient(x, y, r * 0.7, x, y, haloR);
      hg.addColorStop(0,   rgba(c, (this.huge ? 0.75 : 0.55) * pulse));
      hg.addColorStop(0.4, rgba(c, (this.huge ? 0.35 : 0.22) * pulse));
      hg.addColorStop(1,   rgba(c, 0));
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(x, y, haloR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Rotating sunburst rays — huge balls only
      if (this.huge) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.translate(x, y);
        ctx.rotate(this.haloRotation);
        const rayCount = 12;
        const innerR = r * 1.4;
        const outerR = r * 2.4;
        for (let i = 0; i < rayCount; i++) {
          const a = (i / rayCount) * Math.PI * 2;
          const ix = Math.cos(a) * innerR;
          const iy = Math.sin(a) * innerR;
          const ox = Math.cos(a) * outerR;
          const oy = Math.sin(a) * outerR;
          const rayGrad = ctx.createLinearGradient(ix, iy, ox, oy);
          rayGrad.addColorStop(0, rgba(c, 0.45 * pulse));
          rayGrad.addColorStop(1, rgba(c, 0));
          ctx.strokeStyle = rayGrad;
          ctx.lineWidth = 2.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(ix, iy);
          ctx.lineTo(ox, oy);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 3D sphere body — light source upper-left
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

      // Specular highlight
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
    if (seeds.length < 28 && Math.random() < 2.4 * dt) {
      seeds.push(new Seed());
    }
  }

  // A pinch flings out a small handful of seeds from the pinch point.
  // Rate-limit is enforced by rising-edge pinch detection in onHandResults
  // (one batch per "release → squeeze" transition).
  //
  // Cap is intentionally generous — pinch should be able to flood the sky.
  // 500 is a runaway-only safety, not a creative ceiling; balls off the
  // bottom edge are culled in Seed.update so accumulation has a natural
  // outlet. Auto-spawn still self-limits at 28 so the ambient sky stays
  // sparse; only pinches can push past that.
  const MAX_SEEDS_TOTAL = 500;
  function spawnPinchBatch(x, y) {
    const want = 6 + Math.floor(Math.random() * 7); // 6-12
    const room = Math.max(0, MAX_SEEDS_TOTAL - seeds.length);
    const n = Math.min(want, room);
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 110 + Math.random() * 120;
      seeds.push(new Seed({
        x: x + (Math.random() - 0.5) * 18,
        y: y + (Math.random() - 0.5) * 18,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.7, // less vertical fling — keep it in view
      }));
    }
  }

  // Long-pinch payoff: a single ~3-4x diameter ball that detonates with a
  // massively scaled 三尺玉-style burst. Triggered by a 5s sustained pinch
  // via the rising-edge logic in onHandResults (see HUGE_CHARGE_SECONDS).
  function spawnHugeBall(x, y) {
    if (seeds.length >= MAX_SEEDS_TOTAL) return;
    seeds.push(new Seed({
      x: x,
      y: y - 30, // appear just above the pinch
      vx: (Math.random() - 0.5) * 16,
      vy: -12, // tiny upward release
      huge: true,
    }));
    playHugeCharge();
  }

  // -------------------------------------------------------------------------
  // Particle pool — supports trails, varying gravity, optional secondary
  // detonation (for 千輪).
  // -------------------------------------------------------------------------
  // Soft cap — spawn functions ignore this and always allocate their full
  // requested count, so a hand sweeping through 10+ balls in one frame
  // guarantees 10 fully-rendered detonations. The cap is enforced lazily
  // once per frame at the END of updateParticles by sorting the array
  // and evicting the dimmest oldest particles first. That way, overlapping
  // bursts always look right; the cap only kicks in for sustained chaos.
  const MAX_PARTICLES = 2500;
  const particlePool = [];
  const particles = [];
  function getParticle() { return particlePool.pop() || {}; }
  function releaseParticle(p) {
    if (particlePool.length < 1200) particlePool.push(p);
  }

  // -------------------------------------------------------------------------
  // Firework styles
  // -------------------------------------------------------------------------
  const STYLE_WEIGHTS = [
    ['chrysanthemum', 0.22],
    ['peony',         0.20],
    ['willow',        0.14],
    ['palm',          0.13],
    ['senrin',        0.11],
    ['twostage',      0.10],
    ['shidare',       0.10], // しだれ柳 — long-trail weeping willow
  ];
  function pickStyle() {
    const r = Math.random();
    let acc = 0;
    for (const [name, w] of STYLE_WEIGHTS) {
      acc += w;
      if (r < acc) return name;
    }
    return 'chrysanthemum';
  }

  // 菊 — radial spherical burst with persistent thick trails. With opts.huge,
  // counts and speeds scale up for the long-pinch detonation.
  function spawnChrysanthemum(x, y, opts) {
    const huge = !!(opts && opts.huge);
    const want = huge
      ? 360 + Math.floor(Math.random() * 140) // 360-500
      : 95  + Math.floor(Math.random() * 35);
    const n = want; // cap enforced lazily in updateParticles, not here
    const base = pickFrom(PAL_REDGOLD);
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.35;
      const sp = Math.pow(Math.random(), 0.45);
      const speed = huge ? 220 + sp * 450 : 130 + sp * 280;
      const c = jitter(base, 35);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = huge ? 1.7 + Math.random() * 0.9 : 1.3 + Math.random() * 0.6;
      p.size = huge ? 2.1 + Math.random() * 2.0 : 1.5 + Math.random() * 1.8;
      p.drag = 0.978 + Math.random() * 0.012;
      p.glow = (huge ? 0.7 : 0.55) + Math.random() * 0.35;
      p.gravity = 200;
      p.trail = true;
      p.trailWidth = huge ? 2.0 : 1.6;
      p.detonate = false;
      particles.push(p);
    }
  }

  // 牡丹 — radial spherical burst, CLEAN dots, no trails. opts.huge scales up.
  function spawnPeony(x, y, opts) {
    const huge = !!(opts && opts.huge);
    const want = huge
      ? 380 + Math.floor(Math.random() * 140) // 380-520
      : 110 + Math.floor(Math.random() * 40);
    const n = want; // cap enforced lazily in updateParticles, not here
    const base = pickFrom(PAL_REDGOLD);
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.25;
      const sp = Math.pow(Math.random(), 0.55);
      const speed = huge ? 240 + sp * 480 : 150 + sp * 320;
      const c = jitter(base, 28);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = huge ? 1.25 + Math.random() * 0.7 : 0.85 + Math.random() * 0.5;
      p.size = huge ? 2.4 + Math.random() * 2.2 : 1.9 + Math.random() * 2.0;
      p.drag = 0.984 + Math.random() * 0.01;
      p.glow = (huge ? 0.75 : 0.6) + Math.random() * 0.35;
      p.gravity = 220;
      p.trail = false;
      p.detonate = false;
      particles.push(p);
    }
  }

  // 柳 — drooping golden trails, heavy gravity, long persistence
  function spawnWillow(x, y) {
    const want = 65 + Math.floor(Math.random() * 25);
    const n = want; // cap enforced lazily in updateParticles, not here
    for (let i = 0; i < n; i++) {
      // Bias initial trajectories upward-and-outward (cone around -π/2)
      const spread = Math.PI * 1.1;
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
      const speed = 140 + Math.random() * 130;
      const c = jitter(pickFrom(PAL_GOLD), 20);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = 2.1 + Math.random() * 0.9;
      p.size = 1.3 + Math.random() * 1.4;
      p.drag = 0.992;
      p.glow = 0.5 + Math.random() * 0.3;
      p.gravity = 320;   // heavy — droops like a willow branch
      p.trail = true;
      p.trailWidth = 1.4;
      p.detonate = false;
      particles.push(p);
    }
  }

  // 椰子 — palm-tree: a small number of THICK arcing streamers
  function spawnPalm(x, y) {
    const want = 9 + Math.floor(Math.random() * 4); // 9-12 streamers
    const n = want; // cap enforced lazily in updateParticles, not here
    const base = pickFrom(PAL_ORANGERED);
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1); // 0..1 across the fan
      const angle = -Math.PI / 2 + (t - 0.5) * Math.PI * 1.25 + (Math.random() - 0.5) * 0.18;
      const speed = 230 + Math.random() * 120;
      const c = jitter(base, 28);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = 1.5 + Math.random() * 0.7;
      p.size = 2.8 + Math.random() * 1.6;
      p.drag = 0.99;
      p.glow = 0.6;
      p.gravity = 260;
      p.trail = true;
      p.trailWidth = 2.0; // very thick fronds
      p.detonate = false;
      particles.push(p);
    }
  }

  // 千輪 — primary sparks that detonate again after a short lifetime
  function spawnSenrin(x, y) {
    const want = 18 + Math.floor(Math.random() * 7);
    const n = want; // cap enforced lazily in updateParticles, not here
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const speed = 150 + Math.random() * 80;
      const baseC = pickFrom(PAL_MULTI);
      const c = jitter(baseC, 25);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = 0.55 + Math.random() * 0.25;
      p.size = 1.8 + Math.random() * 1.3;
      p.drag = 0.985;
      p.glow = 0.6;
      p.gravity = 160;
      p.trail = true;
      p.trailWidth = 1.2;
      p.detonate = true;
      p.detonateColor = pickFrom(PAL_MULTI);
      particles.push(p);
    }
  }

  // Secondary sub-burst when a 千輪 primary expires
  function spawnSubBurst(x, y, baseColor) {
    const want = 9 + Math.floor(Math.random() * 5);
    const n = want; // cap enforced lazily in updateParticles
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 55 + Math.random() * 90;
      const c = jitter(baseColor, 25);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = 0.45 + Math.random() * 0.3;
      p.size = 1.1 + Math.random() * 1.2;
      p.drag = 0.978;
      p.glow = 0.5;
      p.gravity = 200;
      p.trail = false;
      p.detonate = false;
      particles.push(p);
    }
  }

  // 二段咲 — outer ring + inner ring, both spherical, two colors
  function spawnTwostage(x, y) {
    // No per-spawn cap; updateParticles evicts oldest if we exceed.
    const outerN = 65;
    const innerN = 55;
    const outerC = pickFrom(PAL_REDGOLD); // most often a red
    const innerC = { r: 255, g: 220, b: 130 }; // gold core

    for (let i = 0; i < outerN; i++) {
      const angle = (i / outerN) * Math.PI * 2 + Math.random() * 0.08;
      const speed = 250 + Math.random() * 80;
      const c = jitter(outerC, 25);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = 1.05 + Math.random() * 0.45;
      p.size = 1.7 + Math.random() * 1.5;
      p.drag = 0.982;
      p.glow = 0.55;
      p.gravity = 220;
      p.trail = false;
      p.detonate = false;
      particles.push(p);
    }
    for (let i = 0; i < innerN; i++) {
      const angle = (i / innerN) * Math.PI * 2 + Math.PI / Math.max(1, innerN);
      const speed = 130 + Math.random() * 70;
      const c = jitter(innerC, 22);
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.life = 1.0;
      p.maxLife = 0.95 + Math.random() * 0.4;
      p.size = 1.6 + Math.random() * 1.3;
      p.drag = 0.982;
      p.glow = 0.55;
      p.gravity = 220;
      p.trail = false;
      p.detonate = false;
      particles.push(p);
    }
  }

  // しだれ柳 — long-trail weeping willow. ~10% of detonations.
  // - Dense narrow upward cone (38-48 particles, ~117° spread).
  // - 3.6-5.0s lifetime; gravity 50 (vs typical 220) so they hang.
  // - Per-particle wind so trails curve gently instead of being straight.
  // - Color cycles white-hot → gold → deep amber across lifetime, driven
  //   at draw time by shidareColorFor(life).
  // - Each particle drops a slow-fading "ghost" every ~0.13s, so the air
  //   behind the trails stays luminous for ~1s — the signature droop.
  function spawnShidare(x, y) {
    const want = 38 + Math.floor(Math.random() * 11); // 38-48
    const n = want; // cap enforced lazily in updateParticles, not here
    const coneSpread = Math.PI * 0.65; // ~117° total
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * coneSpread;
      const speed = 170 + Math.random() * 100; // 170-270 px/s
      const p = getParticle();
      p.x = x; p.y = y; p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      // Base color stored as gold; shidareColorFor overrides at draw time.
      p.r = 255; p.g = 200; p.b = 87;
      p.life = 1.0;
      p.maxLife = 3.6 + Math.random() * 1.4; // 3.6-5.0s
      p.size = 1.2 + Math.random() * 0.5;
      p.drag = 0.994;
      p.glow = 0.65 + Math.random() * 0.25;
      p.gravity = 50;
      p.trail = true;
      p.trailWidth = 2.4 + Math.random() * 0.5; // line ≈ 3-4 px
      p.detonate = false;
      p.colorMode = 'shidare';
      p.windOffset = (Math.random() - 0.5) * 12; // ±6 px/s² per-particle wind
      p.ghostTimer = 0;
      particles.push(p);
    }
  }

  // Color sequence used by shidare across particle life (1 = fresh, 0 = dead):
  //   life > 0.85 → white-hot fading to gold (the bright flash at peak)
  //   life > 0.30 → pure gold body
  //   life ≤ 0.30 → gold sinking to deep amber as they descend
  function shidareColorFor(life) {
    const lf = life < 0 ? 0 : life > 1 ? 1 : life;
    if (lf > 0.85) {
      const k = (lf - 0.85) / 0.15;
      return { r: 255, g: 200 + 50 * k, b: 87 + 168 * k };
    }
    if (lf > 0.30) {
      return { r: 255, g: 200, b: 87 };
    }
    const k = lf / 0.30;
    return {
      r: 180 + 75 * k, // 180 → 255
      g:  90 + 110 * k, //  90 → 200
      b:  20 +  67 * k, //  20 →  87
    };
  }

  // Ghost trail puffs left behind shidare particles
  const shidareGhosts = [];
  const MAX_GHOSTS = 500;
  function spawnGhost(x, y, color, size) {
    shidareGhosts.push({
      x, y,
      life: 1,
      maxLife: 0.8 + Math.random() * 0.3,
      r: color.r, g: color.g, b: color.b,
      size,
    });
    if (shidareGhosts.length > MAX_GHOSTS) shidareGhosts.shift();
  }
  function updateGhosts(dt) {
    for (let i = shidareGhosts.length - 1; i >= 0; i--) {
      const g = shidareGhosts[i];
      g.life -= dt / g.maxLife;
      if (g.life <= 0) shidareGhosts.splice(i, 1);
    }
  }
  function drawGhosts() {
    if (shidareGhosts.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < shidareGhosts.length; i++) {
      const g = shidareGhosts[i];
      const a = Math.max(0, g.life);
      const fade = a * a * 0.4;
      if (fade < 0.01) continue;
      const r = g.size * 2.6;
      const grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r);
      grad.addColorStop(0, `rgba(${g.r|0},${g.g|0},${g.b|0},${fade})`);
      grad.addColorStop(1, `rgba(${g.r|0},${g.g|0},${g.b|0},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // The detonation dispatcher
  // -------------------------------------------------------------------------
  function explode(x, y, opts) {
    const huge = !!(opts && opts.huge);
    // Huge balls always read as 三尺玉-style spherical bursts: 菊 or 牡丹.
    const style = huge
      ? (Math.random() < 0.5 ? 'chrysanthemum' : 'peony')
      : pickStyle();
    switch (style) {
      case 'chrysanthemum': spawnChrysanthemum(x, y, opts); break;
      case 'peony':         spawnPeony(x, y, opts);         break;
      case 'willow':        spawnWillow(x, y);              break;
      case 'palm':          spawnPalm(x, y);                break;
      case 'senrin':        spawnSenrin(x, y);              break;
      case 'twostage':      spawnTwostage(x, y);            break;
      case 'shidare':       spawnShidare(x, y);             break;
    }
    // Skip smoke for shidare — the delicate gold rain looks better without
    // it; the heavy puff was reading as a tonal mismatch.
    if (style !== 'shidare') spawnSmoke(x, y);
    if (huge) {
      spawnFlash({ duration: 0.5, scale: 1.7 });
      triggerShake(4.5, 0.32);
      playHugeExplosion();
    } else {
      spawnFlash();
      playExplosion();
    }
    if (Math.random() < 0.32) spawnChars(x, y);
  }

  // -------------------------------------------------------------------------
  // Particle update + render
  // -------------------------------------------------------------------------
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.trailX = p.x;
      p.trailY = p.y;

      // Shidare-only extras: gentle horizontal wind + dropped ghost puffs
      if (p.colorMode === 'shidare') {
        p.vx += p.windOffset * dt;
        p.ghostTimer += dt;
        if (p.ghostTimer >= 0.13) {
          p.ghostTimer = 0;
          spawnGhost(p.x, p.y, shidareColorFor(p.life), p.size);
        }
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.gravity || 220) * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.life -= dt / p.maxLife;
      if (p.life <= 0) {
        if (p.detonate) spawnSubBurst(p.x, p.y, p.detonateColor || { r: 255, g: 200, b: 87 });
        releaseParticle(p);
        particles.splice(i, 1);
      }
    }

    // Lazy cap enforcement. Spawn functions allocate their full requested
    // count regardless of MAX_PARTICLES, so a multi-ball hand sweep is
    // guaranteed to fire every burst. If we've blown past the cap, sort
    // by remaining life (ascending) and evict the dimmest particles. They
    // would have died within a frame or two anyway — visually negligible.
    // 'lighter' compositing is order-independent so sorting is safe.
    if (particles.length > MAX_PARTICLES) {
      particles.sort((a, b) => a.life - b.life);
      const excess = particles.length - MAX_PARTICLES;
      for (let i = 0; i < excess; i++) releaseParticle(particles[i]);
      particles.splice(0, excess);
    }
  }

  function drawParticles() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const a = Math.max(0, p.life);
      const fade = a * a;

      // Shidare colors evolve with life — white-hot → gold → amber.
      let pr, pg, pb;
      if (p.colorMode === 'shidare') {
        const c = shidareColorFor(p.life);
        pr = c.r; pg = c.g; pb = c.b;
      } else {
        pr = p.r; pg = p.g; pb = p.b;
      }

      if (p.trail) {
        ctx.strokeStyle = `rgba(${pr|0},${pg|0},${pb|0},${fade * 0.6})`;
        ctx.lineWidth = p.size * (p.trailWidth || 1);
        ctx.beginPath();
        ctx.moveTo(p.trailX, p.trailY);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      const sz = p.size * (1.2 + fade * 0.6);
      ctx.fillStyle = `rgba(${pr|0},${pg|0},${pb|0},${fade})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
      ctx.fill();

      if (fade > 0.05) {
        const haloR = sz * 4 * p.glow;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
        grad.addColorStop(0, `rgba(${pr|0},${pg|0},${pb|0},${fade * 0.5})`);
        grad.addColorStop(1, `rgba(${pr|0},${pg|0},${pb|0},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Smoke (translucent gray puffs after a detonation)
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
      s.vy += 5 * dt;
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
      grad.addColorStop(0,    `rgba(${s.tint},${s.tint},${s.tint + 6},${a})`);
      grad.addColorStop(0.55, `rgba(${s.tint},${s.tint},${s.tint + 6},${a * 0.45})`);
      grad.addColorStop(1,    `rgba(${s.tint},${s.tint},${s.tint + 6},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // -------------------------------------------------------------------------
  // Flash overlay — hot white → yellow → orange → red sweep per detonation
  // -------------------------------------------------------------------------
  const flashes = [];
  const FLASH_DURATION = 0.28;
  // opts: { duration, scale } — huge explosions pass longer/brighter flashes.
  function spawnFlash(opts) {
    flashes.push({
      t: 0,
      duration: (opts && opts.duration) || FLASH_DURATION,
      scale:    (opts && opts.scale)    || 1.0,
    });
    if (flashes.length > 6) flashes.shift();
  }
  function drawFlash(dt) {
    if (flashes.length === 0) return;
    let aggR = 0, aggG = 0, aggB = 0, aggA = 0;
    let maxScale = 1.0;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      const duration = f.duration || FLASH_DURATION;
      const scale    = f.scale    || 1.0;
      f.t += dt;
      if (f.t >= duration) { flashes.splice(i, 1); continue; }
      const t = f.t / duration;
      const a = Math.pow(1 - t, 1.5) * 0.5 * scale;
      let r, g, b;
      if (t < 0.16) {
        const k = t / 0.16;
        r = 255; g = 255 - k * 40; b = 245 - k * 200;
      } else if (t < 0.5) {
        const k = (t - 0.16) / 0.34;
        r = 255; g = 215 - k * 100; b = 45 - k * 15;
      } else {
        const k = (t - 0.5) / 0.5;
        r = 255 - k * 55; g = 115 - k * 110; b = 30 - k * 30;
      }
      aggR += r * a; aggG += g * a; aggB += b * a; aggA += a;
      if (scale > maxScale) maxScale = scale;
    }
    if (aggA <= 0) return;
    // Let big flashes punch through harder — cap scales with the biggest
    // contributing flash (so a huge always lands brighter than a normal one).
    const cap = Math.min(0.55 * maxScale, 0.72);
    ctx.fillStyle = `rgba(${(aggR/aggA)|0},${(aggG/aggA)|0},${(aggB/aggA)|0},${Math.min(aggA, cap)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Camera shake — translates the canvas drawing (not the webcam) for a
  // brief wobble. Applied by the main frame loop, decays linearly.
  let shakeRemain = 0;
  let shakeAmp = 0;
  let shakeDuration = 0;
  function triggerShake(amp, duration) {
    shakeAmp = amp || 4;
    shakeDuration = duration || 0.3;
    shakeRemain = shakeDuration;
  }

  // -------------------------------------------------------------------------
  // Lanterns (background drift)
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
      ctx.globalAlpha = 0.32;
      const halo = ctx.createRadialGradient(this.x, y, 0, this.x, y, 60 * s);
      halo.addColorStop(0, 'rgba(255, 130, 80, 0.45)');
      halo.addColorStop(1, 'rgba(120, 20, 20, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(this.x, y, 60 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(180, 35, 30, 0.85)';
      ctx.beginPath();
      ctx.ellipse(this.x, y, 18 * s, 24 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(80, 25, 15, 0.9)';
      ctx.fillRect(this.x - 9 * s, y - 26 * s, 18 * s, 3 * s);
      ctx.fillRect(this.x - 9 * s, y + 23 * s, 18 * s, 3 * s);
      ctx.strokeStyle = 'rgba(255, 200, 87, 0.7)';
      ctx.lineWidth = 1.2 * s;
      ctx.beginPath();
      ctx.moveTo(this.x, y + 26 * s);
      ctx.lineTo(this.x, y + 44 * s);
      ctx.stroke();
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
  // 福 / 春 chars rising after some bursts
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
      ctx.globalAlpha = Math.min(1, this.life * 1.6);
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
  // Audio — synthesized boom
  // -------------------------------------------------------------------------
  let audioCtx = null, masterGain = null;
  function ensureAudio() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.55;
        const comp = audioCtx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 8;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        masterGain.connect(comp);
        comp.connect(audioCtx.destination);
      } catch (e) { audioCtx = null; }
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

    // Transient click
    const tDur = 0.025;
    const tBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * tDur), ac.sampleRate);
    const tData = tBuf.getChannelData(0);
    for (let i = 0; i < tData.length; i++) {
      tData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / tData.length, 2.5);
    }
    const trans = ac.createBufferSource(); trans.buffer = tBuf;
    const tFilt = ac.createBiquadFilter(); tFilt.type = 'highpass'; tFilt.frequency.value = 600;
    const tGain = ac.createGain(); tGain.gain.value = 0.55;
    trans.connect(tFilt); tFilt.connect(tGain); tGain.connect(masterGain);
    trans.start(now);

    // Body 85→26 Hz, sharp attack
    const body = ac.createOscillator(); const bodyGain = ac.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(85 + Math.random() * 12, now);
    body.frequency.exponentialRampToValueAtTime(26, now + 0.32);
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(1.0, now + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    body.connect(bodyGain); bodyGain.connect(masterGain);
    body.start(now); body.stop(now + 0.46);

    // Sub-bass thump
    const sub = ac.createOscillator(); const subGain = ac.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(42, now);
    sub.frequency.exponentialRampToValueAtTime(16, now + 0.28);
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime(0.7, now + 0.006);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
    sub.connect(subGain); subGain.connect(masterGain);
    sub.start(now); sub.stop(now + 0.38);

    // Lowpass rumble tail
    const rDur = 0.55;
    const rBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * rDur), ac.sampleRate);
    const rData = rBuf.getChannelData(0);
    for (let i = 0; i < rData.length; i++) {
      rData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rData.length, 1.2);
    }
    const rum = ac.createBufferSource(); rum.buffer = rBuf;
    const rFilt = ac.createBiquadFilter(); rFilt.type = 'lowpass'; rFilt.frequency.value = 180; rFilt.Q.value = 0.7;
    const rGain = ac.createGain();
    rGain.gain.setValueAtTime(0.0001, now);
    rGain.gain.exponentialRampToValueAtTime(0.32, now + 0.01);
    rGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    rum.connect(rFilt); rFilt.connect(rGain); rGain.connect(masterGain);
    rum.start(now);

    // Bandpass crackle (secondary)
    const cDur = 0.32;
    const cBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * cDur), ac.sampleRate);
    const cData = cBuf.getChannelData(0);
    for (let i = 0; i < cData.length; i++) {
      const env = Math.pow(1 - i / cData.length, 1.6);
      const spike = Math.random() < 0.05 ? 1.6 : 1.0;
      cData[i] = (Math.random() * 2 - 1) * env * spike;
    }
    const crack = ac.createBufferSource(); crack.buffer = cBuf;
    const cFilt = ac.createBiquadFilter(); cFilt.type = 'bandpass';
    cFilt.frequency.value = 1500 + Math.random() * 1200; cFilt.Q.value = 1.0;
    const cGain = ac.createGain();
    const cStart = now + 0.05;
    cGain.gain.setValueAtTime(0.0001, cStart);
    cGain.gain.linearRampToValueAtTime(0.18, cStart + 0.02);
    cGain.gain.exponentialRampToValueAtTime(0.001, cStart + 0.3);
    crack.connect(cFilt); cFilt.connect(cGain); cGain.connect(masterGain);
    crack.start(cStart); crack.stop(cStart + 0.34);
  }

  // Huge-ball detonation — deeper, heavier, longer than the regular boom.
  // Body 65→18 Hz (vs 85→26), sub 32→10 Hz (vs 42→16), 0.9s rumble.
  function playHugeExplosion() {
    if (!audioCtx) return;
    const ac = audioCtx;
    const now = ac.currentTime;

    // Transient
    const tDur = 0.04;
    const tBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * tDur), ac.sampleRate);
    const tData = tBuf.getChannelData(0);
    for (let i = 0; i < tData.length; i++) {
      tData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / tData.length, 2);
    }
    const trans = ac.createBufferSource(); trans.buffer = tBuf;
    const tFilt = ac.createBiquadFilter(); tFilt.type = 'highpass'; tFilt.frequency.value = 400;
    const tGain = ac.createGain(); tGain.gain.value = 0.7;
    trans.connect(tFilt); tFilt.connect(tGain); tGain.connect(masterGain);
    trans.start(now);

    // Deeper body
    const body = ac.createOscillator(); const bodyGain = ac.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(65 + Math.random() * 10, now);
    body.frequency.exponentialRampToValueAtTime(18, now + 0.55);
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(1.0, now + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    body.connect(bodyGain); bodyGain.connect(masterGain);
    body.start(now); body.stop(now + 0.75);

    // Huge sub
    const sub = ac.createOscillator(); const subGain = ac.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(32, now);
    sub.frequency.exponentialRampToValueAtTime(10, now + 0.4);
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime(0.9, now + 0.008);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    sub.connect(subGain); subGain.connect(masterGain);
    sub.start(now); sub.stop(now + 0.55);

    // Long lowpass rumble
    const rDur = 0.9;
    const rBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * rDur), ac.sampleRate);
    const rData = rBuf.getChannelData(0);
    for (let i = 0; i < rData.length; i++) {
      rData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rData.length, 1.0);
    }
    const rum = ac.createBufferSource(); rum.buffer = rBuf;
    const rFilt = ac.createBiquadFilter(); rFilt.type = 'lowpass'; rFilt.frequency.value = 150; rFilt.Q.value = 0.7;
    const rGain = ac.createGain();
    rGain.gain.setValueAtTime(0.0001, now);
    rGain.gain.exponentialRampToValueAtTime(0.42, now + 0.015);
    rGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    rum.connect(rFilt); rFilt.connect(rGain); rGain.connect(masterGain);
    rum.start(now);

    // Bigger, longer crackle (delayed)
    const cDur = 0.55;
    const cBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * cDur), ac.sampleRate);
    const cData = cBuf.getChannelData(0);
    for (let i = 0; i < cData.length; i++) {
      const env = Math.pow(1 - i / cData.length, 1.4);
      const spike = Math.random() < 0.05 ? 1.8 : 1.0;
      cData[i] = (Math.random() * 2 - 1) * env * spike;
    }
    const crack = ac.createBufferSource(); crack.buffer = cBuf;
    const cFilt = ac.createBiquadFilter(); cFilt.type = 'bandpass';
    cFilt.frequency.value = 1100 + Math.random() * 1000; cFilt.Q.value = 1.0;
    const cGain = ac.createGain();
    const cStart = now + 0.08;
    cGain.gain.setValueAtTime(0.0001, cStart);
    cGain.gain.linearRampToValueAtTime(0.22, cStart + 0.03);
    cGain.gain.exponentialRampToValueAtTime(0.001, cStart + 0.5);
    crack.connect(cFilt); cFilt.connect(cGain); cGain.connect(masterGain);
    crack.start(cStart); crack.stop(cStart + 0.55);
  }

  // Charge-release tone played when the huge ball spawns from the long pinch.
  // Rising resonant sine — gives the appearing ball some sonic weight.
  function playHugeCharge() {
    if (!audioCtx) return;
    const ac = audioCtx;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.5);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    osc.connect(gain); gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + 1.05);
  }

  // Soft upchirp on pinch — gestural acknowledgement, sub-audible loudness
  function playPinch() {
    if (!audioCtx) return;
    const ac = audioCtx;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(820, now + 0.14);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(gain); gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  // -------------------------------------------------------------------------
  // Hand tracking — convex hull of 21 landmarks per detected hand
  // -------------------------------------------------------------------------
  const trackedHands = []; // each: { points[], hull[], tips[], palm{x,y} }
  let lastMpResultAt = 0;
  let lastMpHandsCount = 0;

  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function inflateHull(hull, padding) {
    if (hull.length === 0) return hull;
    let cx = 0, cy = 0;
    for (const p of hull) { cx += p.x; cy += p.y; }
    cx /= hull.length; cy /= hull.length;
    return hull.map(p => {
      const dx = p.x - cx, dy = p.y - cy;
      const d = Math.hypot(dx, dy);
      if (d < 1e-3) return { x: p.x, y: p.y };
      return { x: p.x + dx / d * padding, y: p.y + dy / d * padding };
    });
  }

  function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Tuning knobs for pose classifier — observable on screen via the hand
  // outline color (palette = palm, cyan/gold = pinch, dim gray = neutral).
  const FINGER_EXT_RATIO   = 1.15; // tip-from-palm > base-from-palm * ratio
  const OPEN_PALM_MIN      = 4;    // fingers extended required for "palm"
  const PINCH_PALM_FRACTION = 0.40; // pinch if dist(4,8) < this * palmWidth
  const PINCH_MIN_PX        = 50;  // ...or this many screen pixels
  const HUGE_CHARGE_SECONDS = 5.0; // sustained pinch duration to spawn huge

  // Per-slot persistent state across MediaPipe frames. Index 0 / 1 follow
  // results.multiHandLandmarks order. If a slot disappears (hand removed),
  // its entry stays in the array until the next frame's prevPinch snapshot
  // overwrites — only the new arrival's first frame can be affected, which
  // we handle defensively with wasPinch=true defaults.
  const handPinchState = []; // { pinchStartedAt, spawnedHuge }

  function onHandResults(results) {
    // Snapshot prior pinch state by hand index so we can detect rising
    // edges (release → squeeze) for the spawn trigger.
    const prevPinch = trackedHands.map(h => h.isPinch);
    const prevCount = trackedHands.length;

    trackedHands.length = 0;
    if (results.multiHandLandmarks) {
      for (let i = 0; i < results.multiHandLandmarks.length; i++) {
        const lm = results.multiHandLandmarks[i];
        // Mirror X so the on-screen hull matches the user's mirror view.
        const points = lm.map(p => ({ x: (1 - p.x) * W, y: p.y * H }));
        const hull = inflateHull(convexHull(points), 20);
        const tips = [4, 8, 12, 16, 20].map(j => points[j]);
        let px = 0, py = 0;
        for (const j of [0, 5, 9, 13, 17]) { px += points[j].x; py += points[j].y; }
        const palm = { x: px / 5, y: py / 5 };

        // Palm width: distance between index MCP (5) and pinky MCP (17).
        // Used to scale the pinch threshold so close/far hands both work.
        const palmWidth = Math.hypot(points[5].x - points[17].x,
                                     points[5].y - points[17].y) || 80;

        // Finger extension: tip farther from palm center than its base
        // landmark by a small ratio. Pairs: (tip, base) per finger.
        const pairs = [[4, 2], [8, 6], [12, 10], [16, 14], [20, 18]];
        let extended = 0;
        for (const [tipIdx, baseIdx] of pairs) {
          const tipD  = Math.hypot(points[tipIdx].x - palm.x,  points[tipIdx].y - palm.y);
          const baseD = Math.hypot(points[baseIdx].x - palm.x, points[baseIdx].y - palm.y);
          if (tipD > baseD * FINGER_EXT_RATIO) extended++;
        }
        const isOpenPalm = extended >= OPEN_PALM_MIN;

        // Pinch: thumb tip and index tip close in screen space.
        const thumbTip = points[4], indexTip = points[8];
        const tid = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
        const pinchThreshold = Math.max(PINCH_MIN_PX, palmWidth * PINCH_PALM_FRACTION);
        const isPinch = tid < pinchThreshold;

        // Pose classification (pinch wins over palm if both qualify; "other"
        // covers fist, partial folds, transition frames).
        let pose = 'other';
        if (isPinch) pose = 'pinch';
        else if (isOpenPalm) pose = 'palm';

        // Rising-edge detection. If this slot didn't have a hand last frame
        // we default wasPinch=true so first-frame presence doesn't trigger
        // a phantom spawn batch.
        const wasPinch = i < prevPinch.length ? prevPinch[i] : true;
        const pinchTrigger = !wasPinch && isPinch;

        // Sustained-pinch tracking for the huge-ball charge.
        const nowMs = performance.now();
        let pinchStartedAt = null;
        let spawnedHuge = false;
        if (isPinch) {
          if (pinchTrigger) {
            pinchStartedAt = nowMs;
            spawnedHuge = false;
          } else {
            const prevState = i < handPinchState.length ? handPinchState[i] : null;
            pinchStartedAt = (prevState && prevState.pinchStartedAt) || nowMs;
            spawnedHuge    = !!(prevState && prevState.spawnedHuge);
          }
        }
        const pinchHeldFor = pinchStartedAt ? (nowMs - pinchStartedAt) / 1000 : 0;
        let hugeTrigger = false;
        if (isPinch && pinchHeldFor >= HUGE_CHARGE_SECONDS && !spawnedHuge) {
          hugeTrigger = true;
          spawnedHuge = true;
        }
        const chargeT = Math.min(1, pinchHeldFor / HUGE_CHARGE_SECONDS);

        trackedHands.push({
          points, hull, tips, palm,
          palmWidth,
          extendedCount: extended,
          isOpenPalm, isPinch,
          pose,
          pinchTrigger,
          pinchHeldFor,
          chargeT,
          hugeTrigger,
          pinchStartedAt,
          spawnedHuge,
          pinchPoint: {
            x: (thumbTip.x + indexTip.x) / 2,
            y: (thumbTip.y + indexTip.y) / 2,
          },
        });
      }
    }

    // Persist next-frame state per slot
    handPinchState.length = 0;
    for (const h of trackedHands) {
      handPinchState.push({
        pinchStartedAt: h.pinchStartedAt,
        spawnedHuge:    h.spawnedHuge,
      });
    }

    lastMpResultAt = performance.now();
    lastMpHandsCount = trackedHands.length;
  }

  function drawHandGlow(now) {
    if (trackedHands.length === 0) return;
    const sinceUpdate = now - lastMpResultAt;
    if (sinceUpdate > 1500) return;
    const fade = Math.max(0, 1 - sinceUpdate / 1500);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const h of trackedHands) {
      // Pose drives the visual feedback:
      //   palm  → palette-cycling color (the "ready to detonate" tone)
      //   pinch → cyan ↔ gold pulse (acknowledgement of the spawn gesture)
      //   other → very faint white outline (tracked but not actuating)
      let color, lineA, palmA, tipA, showTips = true;
      if (h.pose === 'pinch') {
        const k = 0.5 + 0.5 * Math.sin(now * 0.006);
        color = {
          r: 100 + (255 - 100) * k,
          g: 220, // both endpoints land near 220
          b: 255 + (110 - 255) * k,
        };
        const pulse = 0.85 + 0.15 * Math.sin(now * 0.012);
        lineA = 0.42 * pulse;
        palmA = 0.5  * pulse;
        tipA  = 0.6  * pulse;
      } else if (h.pose === 'palm') {
        color = paletteAt(now * 0.00012);
        lineA = 0.22;
        palmA = 0.32;
        tipA  = 0.45;
      } else {
        color = { r: 210, g: 220, b: 235 };
        lineA = 0.10;
        palmA = 0.10;
        tipA  = 0.15;
        showTips = false;
      }

      // Hull outline
      if (h.hull.length >= 3) {
        ctx.strokeStyle = rgba(color, lineA * fade);
        ctx.lineWidth = 1.4;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(h.hull[0].x, h.hull[0].y);
        for (let i = 1; i < h.hull.length; i++) ctx.lineTo(h.hull[i].x, h.hull[i].y);
        ctx.closePath();
        ctx.stroke();
      }

      // Palm center glow
      const pgR = 38;
      const pg = ctx.createRadialGradient(h.palm.x, h.palm.y, 0, h.palm.x, h.palm.y, pgR);
      pg.addColorStop(0, rgba(color, palmA * fade));
      pg.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(h.palm.x, h.palm.y, pgR, 0, Math.PI * 2);
      ctx.fill();

      // Fingertip wisps
      if (showTips) {
        for (const tip of h.tips) {
          const r = 22;
          const grad = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, r);
          grad.addColorStop(0,    `rgba(255, 255, 255, ${tipA * fade})`);
          grad.addColorStop(0.35, rgba(color, tipA * fade));
          grad.addColorStop(1,    rgba(color, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Pinch-point indicator — bright bead where the thumb/index meet
      if (h.pose === 'pinch') {
        const pp = h.pinchPoint;
        const r = 22 + 4 * Math.sin(now * 0.012);
        const ppg = ctx.createRadialGradient(pp.x, pp.y, 0, pp.x, pp.y, r);
        ppg.addColorStop(0,    `rgba(255, 245, 210, ${0.85 * fade})`);
        ppg.addColorStop(0.4,  `rgba(180, 240, 255, ${0.55 * fade})`);
        ppg.addColorStop(1,    `rgba(180, 240, 255, 0)`);
        ctx.fillStyle = ppg;
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Charging aura — fades in around 2s, intensifies until 5s.
        // chargeT goes 0..1 across the 5-second hold; visibility starts at
        // chargeT≈0.4 (≈2s) so the first half feels like a normal pinch.
        const visibility = Math.max(0, (h.chargeT - 0.3) / 0.7);
        if (visibility > 0) {
          const auraR = 30 + 110 * visibility;
          const auraPulse = 0.7 + 0.3 * Math.sin(now * (0.005 + 0.015 * visibility));
          const ag = ctx.createRadialGradient(pp.x, pp.y, 0, pp.x, pp.y, auraR);
          ag.addColorStop(0,    `rgba(255, 240, 180, ${0.75 * visibility * auraPulse * fade})`);
          ag.addColorStop(0.45, `rgba(255, 175, 70,  ${0.45 * visibility * auraPulse * fade})`);
          ag.addColorStop(1,    `rgba(255, 90,  0,   0)`);
          ctx.fillStyle = ag;
          ctx.beginPath();
          ctx.arc(pp.x, pp.y, auraR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // Rising-edge pinch handler: consume the trigger on the hand object so a
  // single squeeze yields exactly one batch even across multiple frames.
  function processPinches(now) {
    if (trackedHands.length === 0) return;
    if (now - lastMpResultAt > 600) return;
    for (const h of trackedHands) {
      if (h.pinchTrigger) {
        h.pinchTrigger = false;
        ensureAudio();
        spawnPinchBatch(h.pinchPoint.x, h.pinchPoint.y);
        playPinch();
      }
      if (h.hugeTrigger) {
        h.hugeTrigger = false;
        ensureAudio();
        spawnHugeBall(h.pinchPoint.x, h.pinchPoint.y);
      }
    }
  }

  // Mouse fallback — single-point cursor as a fake one-vertex "hull" so
  // collision still works when the camera isn't producing results yet.
  const mouse = { x: -1000, y: -1000, prevX: -1000, prevY: -1000, active: false, lastUpdate: 0 };
  function setMouse(x, y) {
    mouse.prevX = mouse.active ? mouse.x : x;
    mouse.prevY = mouse.active ? mouse.y : y;
    mouse.x = x; mouse.y = y;
    mouse.active = true;
    mouse.lastUpdate = performance.now();
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------
  function distSegPoint(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-4) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  function checkCollisions(now) {
    const mpFresh = trackedHands.length > 0 && (now - lastMpResultAt) < 600;
    const mouseFresh = mouse.active && (now - mouse.lastUpdate) < 400;
    if (!mpFresh && !mouseFresh) return;

    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      if (!s.alive) continue;

      if (mpFresh) {
        // Only open-palm hands detonate; pinch and neutral poses are inert
        // for the collision check (pinch is the spawn gesture).
        let hit = false;
        for (const h of trackedHands) {
          if (h.pose !== 'palm') continue;
          if (pointInPolygon(h.hull, s.x, s.y)) { hit = true; break; }
        }
        if (hit) {
          s.alive = false;
          explode(s.x, s.y, s.huge ? { huge: true } : undefined);
          continue;
        }
      } else if (mouseFresh) {
        const d = distSegPoint(mouse.prevX, mouse.prevY, mouse.x, mouse.y, s.x, s.y);
        if (d < 46 + s.r) {
          s.alive = false;
          explode(s.x, s.y, s.huge ? { huge: true } : undefined);
        }
      }
    }
  }

  function drawMouseCursor(now) {
    // Only show the mouse-fallback cursor when MediaPipe hasn't produced
    // results in a while — once hands are tracked, the webcam shows the
    // actual hand and any extra cursor would be visual noise.
    const mpFresh = trackedHands.length > 0 && (now - lastMpResultAt) < 600;
    if (mpFresh) return;
    if (!mouse.active || (now - mouse.lastUpdate) > 1200) return;
    const fade = Math.max(0, 1 - (now - mouse.lastUpdate) / 1200);
    const c = paletteAt(now * 0.00012);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const r = 44;
    const grad = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, r);
    grad.addColorStop(0,    `rgba(255,255,255,${0.75 * fade})`);
    grad.addColorStop(0.2,  rgba(c, 0.6 * fade));
    grad.addColorStop(1,    rgba(c, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // MediaPipe Hands init
  // -------------------------------------------------------------------------
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
      console.warn('MediaPipe Hands global missing; using mouse fallback only.');
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
        try { await hands.send({ image: video }); } catch (e) { /* swallow */ }
        sending = false;
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  // -------------------------------------------------------------------------
  // Fallbacks
  // -------------------------------------------------------------------------
  function explodeNearest(x, y, radius = 130) {
    let nearest = null, nd = radius;
    for (const s of seeds) {
      if (!s.alive) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < nd) { nd = d; nearest = s; }
    }
    if (nearest) {
      nearest.alive = false;
      explode(nearest.x, nearest.y);
    } else {
      explode(x, y);
    }
  }

  if (isMobile) {
    video.style.display = 'none';
    const onTouch = (e) => {
      ensureAudio();
      const t = e.touches ? e.touches[0] : e;
      if (!t) return;
      setMouse(t.clientX, t.clientY);
      explodeNearest(t.clientX, t.clientY);
    };
    window.addEventListener('pointerdown', onTouch, { passive: true });
    window.addEventListener('pointermove', (e) => {
      if (e.pressure > 0 || e.buttons > 0) setMouse(e.clientX, e.clientY);
    }, { passive: true });
  } else {
    window.addEventListener('mousemove', (e) => {
      const mpFresh = trackedHands.length > 0 && (performance.now() - lastMpResultAt) < 400;
      if (!mpFresh) setMouse(e.clientX, e.clientY);
    });
    window.addEventListener('mousedown', () => ensureAudio());
    initHandTracking();
  }

  // -------------------------------------------------------------------------
  // Background — translucent night-sky overlay over the webcam, + stars,
  // + faint horizon glow.
  // -------------------------------------------------------------------------
  let bgGradient = null;
  function rebuildBgGradient() {
    bgGradient = ctx.createLinearGradient(0, 0, 0, H);
    bgGradient.addColorStop(0,    'rgba(10, 14, 42, 0.62)');
    bgGradient.addColorStop(0.55, 'rgba(20, 16, 57, 0.55)');
    bgGradient.addColorStop(1,    'rgba(26, 18, 64, 0.48)');
  }
  rebuildBgGradient();
  window.addEventListener('resize', rebuildBgGradient);

  function drawBackground(now) {
    // Clear so the webcam shows through where we don't paint
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, W, H);

    // Stars (additive twinkle)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.twinkle += s.speed;
      s.x += s.drift;
      if (s.x < -2) s.x = W + 2;
      else if (s.x > W + 2) s.x = -2;
      const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(s.twinkle));
      ctx.fillStyle = `rgba(255, 245, 220, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Subtle horizon glow at the bottom
    const horizon = ctx.createLinearGradient(0, H * 0.6, 0, H);
    horizon.addColorStop(0, 'rgba(255, 107, 53, 0)');
    horizon.addColorStop(1, 'rgba(255, 107, 53, 0.05)');
    ctx.fillStyle = horizon;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------
  let lastTime = performance.now();

  function frame(now) {
    const dt = Math.min(0.06, (now - lastTime) / 1000);
    lastTime = now;

    spawnSeeds(dt);
    spawnLantern();

    for (let i = 0; i < seeds.length; i++) seeds[i].update(dt, now * 0.001);
    for (let i = seeds.length - 1; i >= 0; i--) if (!seeds[i].alive) seeds.splice(i, 1);

    for (const l of lanterns) l.update(dt);
    for (let i = lanterns.length - 1; i >= 0; i--) if (lanterns[i].dead) lanterns.splice(i, 1);

    updateParticles(dt);
    updateGhosts(dt);
    updateSmoke(dt);

    for (const c of chars) c.update(dt);
    for (let i = chars.length - 1; i >= 0; i--) if (chars[i].life <= 0) chars.splice(i, 1);

    checkCollisions(now);
    processPinches(now);

    // Camera shake — translates the entire canvas drawing for a brief
    // wobble. The <video> element behind sits in the DOM unaffected, so
    // only the fireworks + night-sky overlay shake (the webcam stays put).
    ctx.save();
    if (shakeRemain > 0) {
      shakeRemain -= dt;
      const k = Math.max(0, shakeRemain / shakeDuration);
      const amp = shakeAmp * k;
      ctx.translate(
        (Math.random() - 0.5) * amp * 2,
        (Math.random() - 0.5) * amp * 2,
      );
    }

    drawBackground(now);
    for (const l of lanterns) l.draw();
    for (const s of seeds) s.draw(now * 0.001);
    drawSmoke();
    drawGhosts();    // shidare lingering glow trails (sit under bright heads)
    drawParticles();
    drawHandGlow(now);
    drawMouseCursor(now);
    for (const c of chars) c.draw();
    drawFlash(dt);

    ctx.restore();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { lastTime = t; frame(t); });

  // -------------------------------------------------------------------------
  // Welcoming bursts so the sky is alive before the user does anything
  // -------------------------------------------------------------------------
  setTimeout(() => explode(W * 0.30, H * 0.40), 700);
  setTimeout(() => explode(W * 0.72, H * 0.55), 1500);
  setTimeout(() => explode(W * 0.50, H * 0.35), 2400);

})();
