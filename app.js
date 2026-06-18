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
      this.r = 3.5 + Math.random() * 2.5; // core 3.5-6 px → ~7-12 visual
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
      const pulse = 0.78 + 0.22 * Math.sin((now - this.t0) * 3 + this.phase);
      const r = this.r * (0.92 + 0.18 * pulse);
      const c = this.color;

      // Soft halo
      const haloR = r * 5.5;
      const grad = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, haloR);
      grad.addColorStop(0,    rgba(c, 0.55 * pulse));
      grad.addColorStop(0.25, rgba(c, 0.28 * pulse));
      grad.addColorStop(1,    rgba(c, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(this.x, this.y, haloR, 0, Math.PI * 2);
      ctx.fill();

      // Bright core (color → white)
      const coreGrad = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r);
      coreGrad.addColorStop(0, `rgba(255,255,240,${0.95 * pulse})`);
      coreGrad.addColorStop(0.55, rgba(c, 0.9));
      coreGrad.addColorStop(1, rgba(c, 0.25));
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
      ctx.fill();
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

  function explode(x, y, color) {
    const count = 70 + Math.floor(Math.random() * 50); // 70-120
    const room = MAX_PARTICLES - particles.length;
    const n = Math.min(count, room);

    // mostly spherical fan-out, some streamer tails
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 90 + Math.random() * 220;
      const sp = Math.pow(Math.random(), 0.6); // bias outward
      const p = getParticle();
      p.x = x; p.y = y;
      p.trailX = x; p.trailY = y;
      p.vx = Math.cos(angle) * speed * (0.4 + sp);
      p.vy = Math.sin(angle) * speed * (0.4 + sp);
      // color jitter around seed hue
      p.r = clamp(color.r + (Math.random() - 0.5) * 80, 30, 255);
      p.g = clamp(color.g + (Math.random() - 0.5) * 80, 30, 255);
      p.b = clamp(color.b + (Math.random() - 0.5) * 80, 30, 255);
      p.life = 1.0;
      p.maxLife = 0.9 + Math.random() * 0.5;
      p.size = 1.1 + Math.random() * 1.8;
      p.drag = 0.985 + Math.random() * 0.01;
      p.glow = 0.4 + Math.random() * 0.4;
      particles.push(p);
    }

    flashAmt = Math.max(flashAmt, 0.55);
    flashColor = color;
    playExplosion(color);

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

  function playExplosion(color) {
    if (!audioCtx) return;
    const ac = audioCtx;
    const now = ac.currentTime;

    // Boom: sine 110→38 Hz, ~0.3s
    const boom = ac.createOscillator();
    const boomGain = ac.createGain();
    boom.type = 'sine';
    const startF = 100 + Math.random() * 30;
    boom.frequency.setValueAtTime(startF, now);
    boom.frequency.exponentialRampToValueAtTime(38, now + 0.28);
    boomGain.gain.setValueAtTime(0.0001, now);
    boomGain.gain.exponentialRampToValueAtTime(0.7, now + 0.012);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    boom.connect(boomGain);
    boomGain.connect(masterGain);
    boom.start(now);
    boom.stop(now + 0.38);

    // Sub-thud (triangle, very low)
    const sub = ac.createOscillator();
    const subGain = ac.createGain();
    sub.type = 'triangle';
    sub.frequency.setValueAtTime(56, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.18);
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    sub.connect(subGain);
    subGain.connect(masterGain);
    sub.start(now);
    sub.stop(now + 0.24);

    // Crackle: noise → bandpass, 0.3s
    const noiseDur = 0.35;
    const noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * noiseDur), ac.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.pow(1 - i / data.length, 1.4);
      // sprinkle in spike-y pops
      const spike = Math.random() < 0.04 ? 1.5 : 1.0;
      data[i] = (Math.random() * 2 - 1) * env * spike;
    }
    const noise = ac.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2200 + Math.random() * 2200;
    filter.Q.value = 1.4;
    const noiseGain = ac.createGain();
    const startN = now + 0.035;
    noiseGain.gain.setValueAtTime(0.0001, startN);
    noiseGain.gain.linearRampToValueAtTime(0.32, startN + 0.02);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, startN + 0.32);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(masterGain);
    noise.start(startN);
    noise.stop(startN + 0.36);

    // Sparkle tail: a short metallic ping (sine ~2-4 kHz)
    const ping = ac.createOscillator();
    const pingGain = ac.createGain();
    ping.type = 'sine';
    const pingF = 2400 + Math.random() * 1600;
    ping.frequency.setValueAtTime(pingF, now + 0.04);
    ping.frequency.exponentialRampToValueAtTime(pingF * 0.5, now + 0.5);
    pingGain.gain.setValueAtTime(0.0001, now + 0.04);
    pingGain.gain.exponentialRampToValueAtTime(0.08, now + 0.06);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    ping.connect(pingGain);
    pingGain.connect(masterGain);
    ping.start(now + 0.04);
    ping.stop(now + 0.58);
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
  let flashAmt = 0;
  let flashColor = null;
  let lastTime = performance.now();
  let lastSeedDecay = 0;

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

    for (const c of chars) c.update(dt);
    for (let i = chars.length - 1; i >= 0; i--) if (chars[i].life <= 0) chars.splice(i, 1);

    checkCollisions(now);

    // draw
    drawBackground(now);
    for (const l of lanterns) l.draw();
    for (const s of seeds) s.draw(now * 0.001);
    drawParticles();
    drawCursor(now);
    for (const c of chars) c.draw();

    // flash overlay (decays quickly)
    if (flashAmt > 0.002 && flashColor) {
      const tint = flashColor;
      ctx.fillStyle = `rgba(${Math.min(255, tint.r + 120)|0},${Math.min(255, tint.g + 120)|0},${Math.min(255, tint.b + 120)|0},${flashAmt * 0.35})`;
      ctx.fillRect(0, 0, W, H);
      flashAmt *= 0.55;
    }

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
