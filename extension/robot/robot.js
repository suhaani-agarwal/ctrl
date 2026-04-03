// robot/robot.js — Roaming cartoon robot overlay for ctrl
// Runs as a content script. Fully self-contained via closed Shadow DOM.

(function ctrlRobotOverlay() {
  'use strict';

  // ── CONSTANTS ──────────────────────────────────────────────────────────
  const ROBOT_W  = 110;
  const ROBOT_H  = 145;
  const MARGIN   = 10;
  const BUBBLE_W = 220;
  const BUBBLE_GAP = 14;
  const HANG_DURATION    = 2400;
  const SAD_DURATION     = 7000;
  const INTERACT_INTERVAL = 5000;

  // ── SVG ────────────────────────────────────────────────────────────────
  const SVG = `
<svg id="ctrl-svg" viewBox="0 0 120 158" overflow="visible"
     xmlns="http://www.w3.org/2000/svg"
     style="width:${ROBOT_W}px;height:auto;display:block">

  <!-- ACCESSORIES layer -->
  <g id="acc-bulb" style="opacity:0">
    <circle cx="88" cy="-10" r="12" fill="#fef08a"/>
    <ellipse cx="88" cy="-10" rx="7" ry="9" fill="#fbbf24" opacity="0.35"/>
    <rect x="84" y="3" width="8" height="7" rx="2" fill="#a16207"/>
    <rect x="85" y="10" width="6" height="2" rx="1" fill="#92400e"/>
    <line x1="88" y1="-24" x2="88" y2="-31" stroke="#fef08a" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="100" y1="-18" x2="106" y2="-22" stroke="#fef08a" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="76"  y1="-18" x2="70"  y2="-22" stroke="#fef08a" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="103" y1="-7" x2="110" y2="-7"  stroke="#fef08a" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="73"  y1="-7" x2="66"  y2="-7"  stroke="#fef08a" stroke-width="2.5" stroke-linecap="round"/>
  </g>

  <g id="acc-sweat" style="opacity:0">
    <path d="M97,21 Q104,28 97,35 Q90,28 97,21Z" fill="#93c5fd"/>
  </g>

  <g id="acc-questions" style="opacity:0">
    <text x="98" y="21" font-size="15" fill="#a78bfa" font-weight="bold" font-family="system-ui,sans-serif">?</text>
    <text x="88" y="7"  font-size="11" fill="#c4b5fd" font-weight="bold" font-family="system-ui,sans-serif">?</text>
  </g>

  <g id="acc-stars" style="opacity:0;transform-box:fill-box;transform-origin:60px 40px">
    <text x="10" y="24" font-size="12" fill="#fbbf24" font-family="system-ui,sans-serif">★</text>
    <text x="95" y="19" font-size="10" fill="#fbbf24" font-family="system-ui,sans-serif">★</text>
    <text x="50" y="10" font-size="9"  fill="#fde68a" font-family="system-ui,sans-serif">★</text>
  </g>

  <g id="acc-speed" style="opacity:0">
    <line x1="14" y1="94"  x2="-20" y2="94"  stroke="#f97316" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="14" y1="104" x2="-16" y2="104" stroke="#f97316" stroke-width="2"   stroke-linecap="round"/>
    <line x1="14" y1="114" x2="-12" y2="114" stroke="#f97316" stroke-width="1.5" stroke-linecap="round"/>
  </g>

  <g id="acc-rocket" style="opacity:0">
    <ellipse cx="60" cy="162" rx="10" ry="7"  fill="#f97316" opacity="0.9"/>
    <ellipse cx="54" cy="166" rx="6"  ry="4"  fill="#fbbf24" opacity="0.75"/>
    <ellipse cx="66" cy="166" rx="6"  ry="4"  fill="#fbbf24" opacity="0.75"/>
    <ellipse cx="60" cy="170" rx="4"  ry="3"  fill="#fff7ed" opacity="0.5"/>
  </g>

  <!-- Hang rope (only visible during hang) -->
  <line id="acc-rope" x1="60" y1="-8" x2="60" y2="-30"
        stroke="#a3e635" stroke-width="3" stroke-linecap="round" opacity="0"/>

  <!-- Tears (sad state) -->
  <g id="acc-tears" style="opacity:0">
    <ellipse cx="39" cy="55" rx="2.5" ry="4" fill="#93c5fd" opacity="0.8"/>
    <ellipse cx="77" cy="55" rx="2.5" ry="4" fill="#93c5fd" opacity="0.8"/>
  </g>

  <!-- LEGS -->
  <g id="leg-l">
    <rect x="28" y="140" width="22" height="14" rx="5" fill="#252542"/>
    <rect x="22" y="148" width="30" height="9"  rx="4.5" fill="#1a1a2e" stroke="#252542" stroke-width="1.5"/>
  </g>
  <g id="leg-r">
    <rect x="70" y="140" width="22" height="14" rx="5" fill="#252542"/>
    <rect x="68" y="148" width="30" height="9"  rx="4.5" fill="#1a1a2e" stroke="#252542" stroke-width="1.5"/>
  </g>

  <!-- NECK + BODY -->
  <rect x="49" y="76" width="22" height="10" rx="4" fill="#252542"/>
  <rect x="16" y="86" width="88" height="54" rx="14" fill="#1a1a30" stroke="#252542" stroke-width="2"/>

  <!-- CHEST SCREEN -->
  <rect x="28" y="95" width="64" height="38" rx="8" fill="#0c0c1a" stroke="#818cf8" stroke-width="1.5"/>
  <g class="cst idle-chest">
    <rect x="36" y="104" width="48" height="2" rx="1" fill="#818cf8" opacity="0.25"/>
    <rect x="36" y="110" width="32" height="2" rx="1" fill="#818cf8" opacity="0.18"/>
    <rect x="36" y="116" width="40" height="2" rx="1" fill="#818cf8" opacity="0.22"/>
    <text x="60" y="127" text-anchor="middle" font-size="7"
          fill="#818cf8" opacity="0.4" font-family="monospace" letter-spacing="2">CTRL</text>
  </g>
  <g class="cst listen-chest">
    <rect class="bar"    x="33" y="108" width="5" height="10" rx="2.5" fill="#4ade80" style="transform-box:fill-box;transform-origin:bottom"/>
    <rect class="bar b2" x="40" y="103" width="5" height="18" rx="2.5" fill="#4ade80" style="transform-box:fill-box;transform-origin:bottom"/>
    <rect class="bar b3" x="47" y="107" width="5" height="12" rx="2.5" fill="#4ade80" style="transform-box:fill-box;transform-origin:bottom"/>
    <rect class="bar b4" x="54" y="100" width="5" height="23" rx="2.5" fill="#4ade80" style="transform-box:fill-box;transform-origin:bottom"/>
    <rect class="bar b3" x="61" y="105" width="5" height="15" rx="2.5" fill="#4ade80" style="transform-box:fill-box;transform-origin:bottom"/>
    <rect class="bar b2" x="68" y="109" width="5" height="8"  rx="2.5" fill="#4ade80" style="transform-box:fill-box;transform-origin:bottom"/>
    <rect class="bar"    x="75" y="107" width="5" height="11" rx="2.5" fill="#4ade80" style="transform-box:fill-box;transform-origin:bottom"/>
  </g>
  <g class="cst think-chest">
    <circle class="cdot d1" cx="46" cy="114" r="5" fill="#a78bfa" style="transform-box:fill-box;transform-origin:center"/>
    <circle class="cdot d2" cx="60" cy="114" r="5" fill="#a78bfa" style="transform-box:fill-box;transform-origin:center"/>
    <circle class="cdot d3" cx="74" cy="114" r="5" fill="#a78bfa" style="transform-box:fill-box;transform-origin:center"/>
  </g>
  <g class="cst act-chest">
    <polygon points="63,97 54,113 62,113 57,128 71,110 62,110" fill="#f97316"/>
    <polygon points="63,97 54,113 62,113 57,128 71,110 62,110" fill="#f97316" opacity="0.5">
      <animateTransform attributeName="transform" type="scale"
        from="1" to="1.1" dur="0.35s" repeatCount="indefinite" additive="sum"/>
    </polygon>
  </g>
  <g class="cst err-chest">
    <line x1="38" y1="100" x2="82" y2="130" stroke="#f87171" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="82" y1="100" x2="38" y2="130" stroke="#f87171" stroke-width="3.5" stroke-linecap="round"/>
  </g>
  <g class="cst sad-chest">
    <path d="M36,110 Q44,118 52,110 Q60,102 68,110 Q76,118 84,110"
          stroke="#94a3b8" stroke-width="2" fill="none" stroke-linecap="round"/>
    <circle cx="52" cy="115" r="3" fill="#94a3b8" opacity="0.4"/>
    <circle cx="68" cy="115" r="3" fill="#94a3b8" opacity="0.4"/>
  </g>

  <!-- ARMS -->
  <g id="arm-l">
    <rect x="2"   y="90" width="14" height="44" rx="7" fill="#252542"/>
    <circle cx="9"   cy="136" r="8" fill="#1c1c38" stroke="#252542" stroke-width="1.5"/>
  </g>
  <g id="arm-r">
    <rect x="104" y="90" width="14" height="44" rx="7" fill="#252542"/>
    <circle cx="111" cy="136" r="8" fill="#1c1c38" stroke="#252542" stroke-width="1.5"/>
  </g>

  <!-- HEAD GROUP -->
  <g id="head-grp">
    <line x1="60" y1="9" x2="60" y2="22" stroke="#3a3a5c" stroke-width="3" stroke-linecap="round"/>
    <circle id="antenna" cx="60" cy="6" r="6" fill="#818cf8"/>

    <rect x="22" y="22" width="76" height="54" rx="18" fill="#1a1a30" stroke="#818cf8" stroke-width="2"/>
    <rect x="14" y="36" width="10" height="20" rx="5" fill="#252542"/>
    <rect x="96" y="36" width="10" height="20" rx="5" fill="#252542"/>

    <!-- Left eye -->
    <g id="eye-l" style="transform-box:fill-box;transform-origin:center">
      <circle cx="42" cy="46" r="13" fill="#0c0c1e"/>
      <circle id="pup-l" cx="42" cy="46" r="8" fill="#818cf8"/>
      <circle cx="45.5" cy="42.5" r="2.8" fill="white" opacity="0.8"/>
      <path id="spark-l"
            d="M42,39 L43.4,44 L48.5,46 L43.4,48 L42,53 L40.6,48 L35.5,46 L40.6,44Z"
            fill="#fef08a" opacity="0" style="transform-box:fill-box;transform-origin:center"/>
      <g id="xeye-l" opacity="0">
        <line x1="37" y1="41" x2="47" y2="51" stroke="#f87171" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="47" y1="41" x2="37" y2="51" stroke="#f87171" stroke-width="2.5" stroke-linecap="round"/>
      </g>
    </g>

    <!-- Right eye -->
    <g id="eye-r" style="transform-box:fill-box;transform-origin:center">
      <circle cx="78" cy="46" r="13" fill="#0c0c1e"/>
      <circle id="pup-r" cx="78" cy="46" r="8" fill="#818cf8"/>
      <circle cx="81.5" cy="42.5" r="2.8" fill="white" opacity="0.8"/>
      <path id="spark-r"
            d="M78,39 L79.4,44 L84.5,46 L79.4,48 L78,53 L76.6,48 L71.5,46 L76.6,44Z"
            fill="#fef08a" opacity="0" style="transform-box:fill-box;transform-origin:center"/>
      <g id="xeye-r" opacity="0">
        <line x1="73" y1="41" x2="83" y2="51" stroke="#f87171" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="83" y1="41" x2="73" y2="51" stroke="#f87171" stroke-width="2.5" stroke-linecap="round"/>
      </g>
    </g>

    <!-- Blush -->
    <ellipse cx="31" cy="57" rx="7" ry="4" fill="#ff69b4" opacity="0.3"/>
    <ellipse cx="89" cy="57" rx="7" ry="4" fill="#ff69b4" opacity="0.3"/>

    <!-- Mouth expressions -->
    <path class="mx smile"      d="M 44 66 Q 60 76 76 66"                               stroke="#818cf8" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <ellipse class="mx open"   cx="60" cy="67" rx="10" ry="7"                           fill="#0a0a1a"  stroke="#4ade80"  stroke-width="2"/>
    <path class="mx think"      d="M 45 67 L 51 62 L 57 67 L 63 62 L 69 67 L 75 67"     stroke="#a78bfa" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path class="mx determined" d="M 45 67 L 75 67"                                      stroke="#f97316" stroke-width="3" stroke-linecap="round"/>
    <path class="mx sad"        d="M 44 71 Q 60 62 76 71"                                stroke="#f87171" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path class="mx happy"      d="M 42 64 Q 60 80 78 64"                                stroke="#4ade80" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>
</svg>`;

  // ── OVERLAY MARKUP ─────────────────────────────────────────────────────
  const MARKUP = `
<div id="ctrl-root" data-state="idle">
  <div id="ctrl-robot">
    <div id="ctrl-flip">${SVG}</div>
  </div>

  <div id="ctrl-bubble" data-type="speech" data-side="right" style="display:none">
    <div id="ctrl-bubble-icon"></div>
    <div id="ctrl-bubble-body"><span id="ctrl-bubble-text"></span></div>
    <div id="ctrl-bubble-tail"></div>
  </div>

  <div id="ctrl-mic" data-active="false">
    <div id="ctrl-mic-ring"></div>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
         style="width:18px;height:18px;flex-shrink:0">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
    <span id="ctrl-mic-lbl">speak</span>
  </div>

  <div id="ctrl-mute" title="Silence &amp; freeze robot">🔇</div>
  <div id="ctrl-stop" title="Stop current task" style="display:none">⏹</div>
</div>`;

  // ── SHADOW DOM REFS ────────────────────────────────────────────────────
  let host, shadow, root, robotEl, flipEl, svgEl, headGrp;
  let bubbleEl, bubbleIcon, bubbleText, micEl, micLbl;
  let legL, legR, armL, armR;
  let accBulb, accSweat, accQ, accStars, accSpeed, accRocket, accRope, accTears;
  let sparkL, sparkR, xeyeL, xeyeR, antEl;

  // ── PHYSICS STATE ─────────────────────────────────────────────────────
  let state = 'idle';
  const pos = { x: 200, y: 200 };
  let vx = 0, vy = 0, facing = -1;
  let walkPhase = 0, distTravel = 0;
  let targetX = null, targetY = null;
  let paceL = 0, paceR = 0;
  let wanderTs = 0, wanderInt = 4000;
  let rafId = null;
  let vw = window.innerWidth, vh = window.innerHeight;

  // ── BEHAVIOR STATE ─────────────────────────────────────────────────────
  let isHanging = false, hangTimer = null;
  let isSadCorner = false, sadTimer = null;
  let lastInteractCheck = 0;
  let doingInteraction = false;
  let idleActivityTs = 0;       // for occasional idle sit-down

  // ── ROBOT DRAG STATE ───────────────────────────────────────────────────
  let robotDrag = false, robotDragOX = 0, robotDragOY = 0;
  let robotDragStartX = 0, robotDragStartY = 0;
  let robotDragMoved = false;

  // ── BUBBLE STATE ──────────────────────────────────────────────────────
  const queue = [];
  let activeMsg = null, msgTimer = null, typeTimer = null;

  // ── AUDIO PLAYBACK ─────────────────────────────────────────────────────
  let audioCtx = null, audioNextStart = 0;

  function ensureAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext({ sampleRate: 24000 });
      audioNextStart = 0;
    }
    return audioCtx;
  }

  function playAudio(b64) {
    if (isMuted) return;
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
      const raw = atob(b64);
      const pcm = new Int16Array(raw.length / 2);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
      }
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
      const buf = ctx.createBuffer(1, f32.length, 24000);
      buf.getChannelData(0).set(f32);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      const start = Math.max(now, audioNextStart);
      src.start(start);
      audioNextStart = start + buf.duration;
    } catch (e) {
      console.warn('ctrl robot audio:', e);
    }
  }

  // ── MUTE / FREEZE STATE ───────────────────────────────────────────────
  let isMuted = false;

  // ── MIC STATE ─────────────────────────────────────────────────────────
  let micActive = false, pillFixed = false;
  let pillX = 0, pillY = 0;
  let micDrag = false, dragOX = 0, dragOY = 0;
  let dragStartX = 0, dragStartY = 0;

  window.addEventListener('resize', () => { vw = window.innerWidth; vh = window.innerHeight; });

  // ── MOUNT ──────────────────────────────────────────────────────────────
  function mount() {
    document.getElementById('ctrl-robot-host')?.remove();

    host = document.createElement('div');
    host.id = 'ctrl-robot-host';
    Object.assign(host.style, {
      position: 'fixed', top: '0', left: '0',
      width: '100vw', height: '100vh',
      overflow: 'visible', zIndex: '2147483646',
      pointerEvents: 'none', contain: 'layout style',
    });
    document.body.appendChild(host);

    shadow = host.attachShadow({ mode: 'closed' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('robot/robot.css');
    shadow.appendChild(link);

    const container = document.createElement('div');
    container.innerHTML = MARKUP;
    shadow.appendChild(container);

    root      = shadow.getElementById('ctrl-root');
    robotEl   = shadow.getElementById('ctrl-robot');
    flipEl    = shadow.getElementById('ctrl-flip');
    svgEl     = shadow.getElementById('ctrl-svg');
    headGrp   = shadow.getElementById('head-grp');
    bubbleEl  = shadow.getElementById('ctrl-bubble');
    bubbleIcon= shadow.getElementById('ctrl-bubble-icon');
    bubbleText= shadow.getElementById('ctrl-bubble-text');
    micEl     = shadow.getElementById('ctrl-mic');
    micLbl    = shadow.getElementById('ctrl-mic-lbl');
    legL      = shadow.getElementById('leg-l');
    legR      = shadow.getElementById('leg-r');
    armL      = shadow.getElementById('arm-l');
    armR      = shadow.getElementById('arm-r');
    accBulb   = shadow.getElementById('acc-bulb');
    accSweat  = shadow.getElementById('acc-sweat');
    accQ      = shadow.getElementById('acc-questions');
    accStars  = shadow.getElementById('acc-stars');
    accSpeed  = shadow.getElementById('acc-speed');
    accRocket = shadow.getElementById('acc-rocket');
    accRope   = shadow.getElementById('acc-rope');
    accTears  = shadow.getElementById('acc-tears');
    sparkL    = shadow.getElementById('spark-l');
    sparkR    = shadow.getElementById('spark-r');
    xeyeL     = shadow.getElementById('xeye-l');
    xeyeR     = shadow.getElementById('xeye-r');
    antEl     = shadow.getElementById('antenna');

    pos.x = vw - ROBOT_W - 60;
    pos.y = vh - ROBOT_H - 90;

    setupMuteBtn();
    setupMic();
    setupRobotDrag();
    applyState('idle');
    rafId = requestAnimationFrame(raf);
  }

  // ── RAF LOOP ───────────────────────────────────────────────────────────
  function raf(ts) {
    if (!robotEl.isConnected) { rafId = null; setTimeout(mount, 200); return; }
    rafId = requestAnimationFrame(raf);

    if (isSadCorner || isHanging) {
      robotEl.style.transform = `translate(${pos.x.toFixed(1)}px,${pos.y.toFixed(1)}px)`;
      updateBubblePos();
      updateMicPos();
      return;
    }

    applyForces(ts);

    pos.x += vx;
    pos.y += vy;

    // Clamp + bounce
    if (pos.x < MARGIN) {
      pos.x = MARGIN; vx = Math.abs(vx) * 0.65; facing = 1; doBounce();
    } else if (pos.x + ROBOT_W > vw - MARGIN) {
      pos.x = vw - MARGIN - ROBOT_W; vx = -Math.abs(vx) * 0.65; facing = -1; doBounce();
    }

    // Top edge: hang check when acting
    if (pos.y < MARGIN) {
      if (state === 'acting' && !isHanging && vy < -1.5) {
        pos.y = MARGIN;
        startHanging();
      } else {
        pos.y = MARGIN; vy = Math.abs(vy) * 0.6;
      }
    } else if (pos.y + ROBOT_H > vh - MARGIN) {
      pos.y = vh - MARGIN - ROBOT_H; vy = -Math.abs(vy) * 0.6;
    }

    // Walk cycle
    const spd = Math.hypot(vx, vy);
    if (spd > 0.25) {
      distTravel += spd;
      walkPhase = (distTravel / 26) * Math.PI * 2;

      if (vy < -0.8) {
        // STAIR-CLIMBING: exaggerated leg lifts like stepping up stairs
        const stairPhase = (distTravel / 18) * Math.PI * 2;
        const liftL = Math.max(0, Math.sin(stairPhase)) * 40;
        const liftR = Math.max(0, Math.sin(stairPhase + Math.PI)) * 40;
        legL.style.transform = `rotate(${(-liftL).toFixed(1)}deg) translateY(${(-liftL * 0.3).toFixed(1)}px)`;
        legR.style.transform = `rotate(${(-liftR).toFixed(1)}deg) translateY(${(-liftR * 0.3).toFixed(1)}px)`;
        // Arms reach forward-upward like grabbing a railing
        armL.style.transform = `rotate(${(-30 - liftL * 0.5).toFixed(1)}deg)`;
        armR.style.transform = `rotate(${(-30 - liftR * 0.5).toFixed(1)}deg)`;
        svgEl.style.marginTop = `${(-Math.abs(Math.sin(stairPhase)) * 5).toFixed(1)}px`;
      } else {
        // Normal walk
        const la = Math.sin(walkPhase) * 24;
        const aa = Math.sin(walkPhase) * 18;
        const bob = -Math.abs(Math.sin(walkPhase * 2)) * 3;
        legL.style.transform = `rotate(${la.toFixed(2)}deg)`;
        legR.style.transform = `rotate(${(-la).toFixed(2)}deg)`;
        armL.style.transform = `rotate(${(-aa).toFixed(2)}deg)`;
        armR.style.transform = `rotate(${aa.toFixed(2)}deg)`;
        svgEl.style.marginTop = `${bob.toFixed(1)}px`;
      }
    } else {
      legL.style.transform = legR.style.transform = '';
      armL.style.transform = armR.style.transform = '';
      svgEl.style.marginTop = '0';
    }

    if (Math.abs(vx) > 0.15) facing = vx > 0 ? 1 : -1;

    robotEl.style.transform = `translate(${pos.x.toFixed(1)}px,${pos.y.toFixed(1)}px)`;
    flipEl.style.transform  = `scaleX(${facing})`;

    // Periodic element interaction check
    if (state === 'acting' && !doingInteraction && ts - lastInteractCheck > INTERACT_INTERVAL) {
      lastInteractCheck = ts;
      checkElementInteraction();
    }

    updateBubblePos();
    updateMicPos();
  }

  function applyForces(ts) {
    if (isMuted) { vx *= 0.5; vy *= 0.5; return; }
    switch (state) {
      case 'idle': {
        if (ts - wanderTs > wanderInt) {
          const a = Math.random() * Math.PI * 2;
          const s = 0.6 + Math.random() * 1.2;
          vx = Math.cos(a) * s;
          vy = Math.sin(a) * s * 0.35;
          wanderTs = ts;
          wanderInt = 3500 + Math.random() * 5000;
        }
        vx *= 0.994; vy *= 0.990;

        // Occasionally sit down for a moment
        if (ts - idleActivityTs > 15000 + Math.random() * 20000) {
          idleActivityTs = ts;
          doIdleSitDown();
        }
        break;
      }
      case 'listening': {
        vx *= 0.82; vy *= 0.82;
        break;
      }
      case 'thinking': {
        if (!paceL && !paceR) {
          paceL = Math.max(MARGIN, pos.x - 55);
          paceR = Math.min(vw - ROBOT_W - MARGIN, pos.x + 55);
        }
        if (pos.x <= paceL) vx =  1.7;
        if (pos.x >= paceR) vx = -1.7;
        vy *= 0.88;
        break;
      }
      case 'acting': {
        if (targetX !== null) {
          const dx = targetX - pos.x, dy = targetY - pos.y;
          const d  = Math.hypot(dx, dy);
          if (d < 10) { doArrived(); }
          else {
            const s = Math.min(5.5, d * 0.09 + 2.2);
            vx = (dx / d) * s; vy = (dy / d) * s;
          }
        } else {
          vx = facing * 2.8; vy *= 0.93;
        }
        break;
      }
      case 'error': {
        vx *= 0.75; vy *= 0.75;
        break;
      }
    }
  }

  function doBounce() {
    svgEl.animate(
      [{ transform: 'scaleY(0.88) scaleX(1.06)' }, { transform: 'scaleY(1) scaleX(1)' }],
      { duration: 200, easing: 'ease-out' }
    );
  }

  function doArrived() {
    targetX = null; targetY = null;
    svgEl.animate(
      [{ transform: 'scale(1.16)' }, { transform: 'scale(0.92)' }, { transform: 'scale(1)' }],
      { duration: 380, easing: 'cubic-bezier(0.34,1.56,0.64,1)' }
    );
  }

  // ── IDLE SIT-DOWN ──────────────────────────────────────────────────────
  function doIdleSitDown() {
    if (state !== 'idle') return;
    vx = 0; vy = 0;
    // Squat legs
    legL.style.transform = 'rotate(45deg)';
    legR.style.transform = 'rotate(-45deg)';
    const sitMsgs = [
      'Just chilling 😌', 'Taking a break~', '...', '*yawns*',
      'Ready when you are!', 'Waiting for commands!', 'La la la...'
    ];
    enqueue(sitMsgs[Math.floor(Math.random() * sitMsgs.length)], 'speech', 2200);
    setTimeout(() => {
      if (state === 'idle') {
        legL.style.transform = '';
        legR.style.transform = '';
        // Resume wandering
        const a = Math.random() * Math.PI * 2;
        vx = Math.cos(a) * 0.8;
        vy = Math.sin(a) * 0.3;
      }
    }, 2500);
  }

  // ── HANGING FROM TOP ───────────────────────────────────────────────────
  function startHanging() {
    isHanging = true;
    vy = 0; vx = 0;

    // Show rope
    accRope.style.opacity = '1';
    // Arms up (holding on)
    armL.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-120deg)' }], { duration: 400, fill: 'forwards', easing: 'ease-out' });
    armR.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(120deg)' }],  { duration: 400, fill: 'forwards', easing: 'ease-out' });
    // Legs dangle
    legL.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(20deg)' }],  { duration: 600, fill: 'forwards', easing: 'ease-in-out' });
    legR.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-20deg)' }], { duration: 600, fill: 'forwards', easing: 'ease-in-out' });
    // Slight sway
    robotEl.animate(
      [{ transform: `translate(${pos.x.toFixed(0)}px,${pos.y.toFixed(0)}px) rotate(-10deg)` },
       { transform: `translate(${pos.x.toFixed(0)}px,${pos.y.toFixed(0)}px) rotate(10deg)` }],
      { duration: 800, iterations: 3, direction: 'alternate', easing: 'ease-in-out' }
    );

    const hangMsgs = ['Wheee! 🙃', '*clings to ceiling*', 'I can see everything!', 'Spider-robot, spider-robot~'];
    enqueue(hangMsgs[Math.floor(Math.random() * hangMsgs.length)], 'shout', 1800);

    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      // Let go
      accRope.style.opacity = '0';
      armL.getAnimations().forEach(a => a.cancel());
      armR.getAnimations().forEach(a => a.cancel());
      legL.getAnimations().forEach(a => a.cancel());
      legR.getAnimations().forEach(a => a.cancel());
      legL.style.transform = legR.style.transform = '';
      armL.style.transform = armR.style.transform = '';
      isHanging = false;
      vy = 4; // fall back down
    }, HANG_DURATION);
  }

  // ── SAD CORNER ─────────────────────────────────────────────────────────
  function enterSadCorner() {
    isSadCorner = true;
    applyState('sad');
    vx = 0; vy = 0;

    // Slump animation
    svgEl.animate(
      [{ transform: 'rotate(0deg) translateY(0)' }, { transform: 'rotate(-8deg) translateY(10px)' }],
      { duration: 500, fill: 'forwards', easing: 'ease-out' }
    );
    // Arms droop
    armL.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(25deg)' }], { duration: 500, fill: 'forwards' });
    armR.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-25deg)' }],{ duration: 500, fill: 'forwards' });
    // Legs sit
    legL.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(50deg)' }], { duration: 500, fill: 'forwards' });
    legR.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-50deg)' }],{ duration: 500, fill: 'forwards' });

    const sadMsgs = [
      '...fine...', '*sits in corner*', 'I\'ll just be here then...',
      'You didn\'t have to drag me 😢', 'Just needed some alone time...'
    ];
    enqueue(sadMsgs[Math.floor(Math.random() * sadMsgs.length)], 'speech', 3000);

    clearTimeout(sadTimer);
    sadTimer = setTimeout(() => {
      isSadCorner = false;
      // Recover animations
      svgEl.getAnimations().forEach(a => a.cancel());
      armL.getAnimations().forEach(a => a.cancel());
      armR.getAnimations().forEach(a => a.cancel());
      legL.getAnimations().forEach(a => a.cancel());
      legR.getAnimations().forEach(a => a.cancel());
      legL.style.transform = legR.style.transform = '';
      armL.style.transform = armR.style.transform = '';
      svgEl.style.transform = '';

      applyState('idle');
      enqueue('Ok, back to work! 💪', 'shout', 2000);
      // Bounce back into action
      const a = Math.random() * Math.PI * 2;
      vx = Math.cos(a) * 1.5;
      vy = Math.sin(a) * 0.5;
    }, SAD_DURATION);
  }

  // ── ELEMENT INTERACTION ────────────────────────────────────────────────
  function checkElementInteraction() {
    if (state !== 'acting') return;
    const selectors = 'input[type="search"], input[type="text"], [role="searchbox"], button[type="submit"], input[type="submit"]';
    const elements = Array.from(document.querySelectorAll(selectors)).slice(0, 8);
    for (const el of elements) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) continue;
        const cx = pos.x + ROBOT_W / 2;
        const cy = pos.y + ROBOT_H / 2;
        const dist = Math.hypot(rect.left + rect.width / 2 - cx, rect.top + rect.height / 2 - cy);
        if (dist < 140 && dist > 20) {
          doPushAnimation(rect);
          return;
        }
      } catch (_) {}
    }
  }

  function doPushAnimation(rect) {
    doingInteraction = true;
    const isLeft = (rect.left + rect.width / 2) < (pos.x + ROBOT_W / 2);
    const arm = isLeft ? armL : armR;
    const rotDir = isLeft ? -55 : 55;

    arm.animate(
      [{ transform: 'rotate(0deg)' },
       { transform: `rotate(${rotDir}deg)` },
       { transform: `rotate(${rotDir * 0.6}deg)` },
       { transform: `rotate(${rotDir}deg)` },
       { transform: 'rotate(0deg)' }],
      { duration: 900, easing: 'ease-in-out' }
    );

    const pushMsgs = ['Oh! A search box!', '*pokes button*', 'Can I click this?', 'Interesting element!', '*waves at input*'];
    enqueue(pushMsgs[Math.floor(Math.random() * pushMsgs.length)], 'speech', 2000);

    setTimeout(() => { doingInteraction = false; }, 1200);
  }

  // ── STATE MACHINE ──────────────────────────────────────────────────────
  function applyState(newState) {
    if (state === newState) return;
    state = newState;
    root.dataset.state = newState;

    if (newState !== 'thinking') { paceL = 0; paceR = 0; }

    // Accessories
    accSweat.style.opacity  = newState === 'thinking' ? '1' : '0';
    accQ.style.opacity      = newState === 'thinking' ? '1' : '0';
    accBulb.style.opacity   = newState === 'thinking' ? '0.85' : '0';
    accSpeed.style.opacity  = newState === 'acting'   ? '1' : '0';
    accRocket.style.opacity = newState === 'acting'   ? '1' : '0';
    accStars.style.opacity  = newState === 'error'    ? '1' : '0';
    accTears.style.opacity  = newState === 'sad'      ? '1' : '0';
    accRope.style.opacity   = '0';
    xeyeL.style.opacity     = newState === 'error'    ? '1' : '0';
    xeyeR.style.opacity     = newState === 'error'    ? '1' : '0';
    sparkL.style.opacity    = '0';
    sparkR.style.opacity    = '0';

    headGrp.getAnimations().forEach(a => a.cancel());
  }

  function playBulbFlash() {
    // Big idea flash (thinking → acting transition)
    accBulb.style.opacity = '1';
    accBulb.animate(
      [{ transform: 'scale(0.2)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }],
      { duration: 440, easing: 'cubic-bezier(0.34,1.56,0.64,1)', fill: 'forwards' }
    );
    setTimeout(() => {
      [sparkL, sparkR].forEach(e => {
        e.style.opacity = '1';
        e.animate(
          [{ transform: 'scale(0.3)', opacity: 0 }, { transform: 'scale(1.3)', opacity: 1 }, { transform: 'scale(1)', opacity: 1 }],
          { duration: 320, fill: 'forwards' }
        );
      });
    }, 280);
    setTimeout(() => {
      svgEl.animate(
        [{ transform: 'scaleY(0.86) scaleX(1.12)' }, { transform: 'scaleY(1.14) scaleX(0.92)' }, { transform: 'scaleY(1) scaleX(1)' }],
        { duration: 440, easing: 'cubic-bezier(0.34,1.56,0.64,1)' }
      );
    }, 360);
    robotEl.animate(
      [{ filter: 'drop-shadow(0 0 36px #fef08a99)' }, { filter: 'drop-shadow(0 0 8px rgba(129,140,248,.1))' }],
      { duration: 900, delay: 200, easing: 'ease-out' }
    );
    setTimeout(() => {
      accBulb.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: 'forwards' })
        .finished.then(() => { accBulb.style.opacity = '0'; });
      [sparkL, sparkR].forEach(e =>
        e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: 'forwards' })
          .finished.then(() => { e.style.opacity = '0'; })
      );
      applyState('acting');
    }, 920);
  }

  // ── SPEECH BUBBLE ──────────────────────────────────────────────────────
  // readMs = how long the bubble stays AFTER typing finishes (not including type time)
  function enqueue(text, type = 'speech', readMs = null) {
    if (isMuted) return; // silent mode

    // Auto-calculate read time from text length if not specified
    const chars = Math.min(text.length, 100);
    const autoRead = Math.max(3000, chars * 65);
    const finalRead = readMs != null ? Math.max(readMs, 2000) : autoRead;

    if (type === 'thought') {
      const i = queue.findIndex(m => m.type === 'thought');
      if (i !== -1) queue.splice(i, 1);
    }
    if (type === 'shout') queue.unshift({ text, type, readMs: finalRead });
    else queue.push({ text, type, readMs: finalRead });
    if (!activeMsg) processQueue();
  }

  function processQueue() {
    if (!queue.length) { hideBubble(); activeMsg = null; return; }
    activeMsg = queue.shift();
    showBubble(activeMsg.text, activeMsg.type, activeMsg.readMs);
  }

  function showBubble(text, type, readMs) {
    clearInterval(typeTimer);
    clearTimeout(msgTimer);
    bubbleEl.dataset.type = type;

    // Icon based on type
    const icons = { thought: '💡', action: '⚙️', shout: '✅' };
    if (icons[type]) {
      bubbleIcon.textContent = icons[type];
      bubbleIcon.style.display = 'block';
    } else {
      bubbleIcon.style.display = 'none';
    }

    // Cancel any lingering fill:forwards animations from the previous close
    bubbleEl.getAnimations().forEach(a => a.cancel());
    bubbleEl.style.opacity = '';
    bubbleEl.style.transform = '';
    bubbleEl.style.display = 'block';
    bubbleEl.animate(
      [{ transform: 'scale(0.35)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 300, easing: 'cubic-bezier(0.34,1.56,0.64,1)' }
    );

    const capped = text.slice(0, 100);
    bubbleText.textContent = '';
    let i = 0;
    // Start close timer only AFTER typing finishes
    typeTimer = setInterval(() => {
      if (i < capped.length) {
        bubbleText.textContent += capped[i++];
      } else {
        clearInterval(typeTimer);
        typeTimer = null;
        // Text fully visible — now start the read timer
        msgTimer = setTimeout(closeBubble, readMs);
      }
    }, 20);
  }

  function closeBubble() {
    clearInterval(typeTimer);
    clearTimeout(msgTimer);
    // No fill:'forwards' — we hide via style.display in the callback instead
    const a = bubbleEl.animate(
      [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.65)', opacity: 0 }],
      { duration: 210, easing: 'ease-in' }
    );
    a.finished.then(() => {
      bubbleEl.getAnimations().forEach(x => x.cancel()); // ensure clean slate
      bubbleEl.style.display = 'none';
      bubbleEl.style.opacity = '';
      bubbleEl.style.transform = '';
      activeMsg = null;
      processQueue();
    });
  }

  function hideBubble() {
    clearInterval(typeTimer);
    clearTimeout(msgTimer);
    bubbleEl.style.display = 'none';
  }

  function updateBubblePos() {
    if (bubbleEl.style.display === 'none') return;
    const BW = BUBBLE_W, BH = 88, G = BUBBLE_GAP;
    let bx, by, side;

    if (pos.x + ROBOT_W + G + BW < vw) {
      bx = pos.x + ROBOT_W + G; side = 'right';
    } else if (pos.x - G - BW > 0) {
      bx = pos.x - G - BW; side = 'left';
    } else {
      bx = pos.x + ROBOT_W / 2 - BW / 2; side = 'top';
    }

    by = Math.max(8, Math.min(vh - BH - 8, pos.y + ROBOT_H * 0.12));
    bx = Math.max(8, Math.min(vw - BW - 8, bx));

    bubbleEl.style.left = bx.toFixed(0) + 'px';
    bubbleEl.style.top  = by.toFixed(0) + 'px';
    bubbleEl.dataset.side = side;
  }

  // ── MUTE + STOP BUTTONS ────────────────────────────────────────────────
  function setupMuteBtn() {
    // Stop button
    const stopEl = shadow.getElementById('ctrl-stop');
    if (stopEl) {
      stopEl.style.pointerEvents = 'auto';
      stopEl.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'ABORT_TASK' }).catch(() => {});
        applyState('idle');
        targetX = null; targetY = null;
        queue.length = 0;
        hideBubble(); activeMsg = null;
        enqueue('Task stopped.', 'speech', null);
        stopEl.style.display = 'none';
      });
    }

    const muteEl = shadow.getElementById('ctrl-mute');
    if (!muteEl) return;
    muteEl.style.pointerEvents = 'auto';
    muteEl.addEventListener('click', (e) => {
      e.stopPropagation();
      isMuted = !isMuted;
      muteEl.textContent = isMuted ? '🔔' : '🔇';
      muteEl.title = isMuted ? 'Unmute & resume robot' : 'Silence & freeze robot';
      muteEl.classList.toggle('active', isMuted);
      root.dataset.muted = isMuted ? 'true' : 'false';

      if (isMuted) {
        // Stop everything
        vx = 0; vy = 0;
        queue.length = 0;
        hideBubble();
        activeMsg = null;
        isSadCorner = false;
        isHanging = false;
        // Sit the robot down quietly
        legL.style.transform = 'rotate(40deg)';
        legR.style.transform = 'rotate(-40deg)';
        armL.style.transform = 'rotate(15deg)';
        armR.style.transform = 'rotate(-15deg)';
      } else {
        // Resume
        if (audioCtx?.state === 'suspended') audioCtx.resume();
        legL.style.transform = legR.style.transform = '';
        armL.style.transform = armR.style.transform = '';
        applyState('idle');
        wanderTs = 0; // trigger new wander immediately
      }
    });
  }

  // ── MIC PILL ───────────────────────────────────────────────────────────
  function setupMic() {
    micEl.style.pointerEvents = 'auto';

    micEl.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      micDrag = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      dragOX = e.clientX - parseFloat(micEl.style.left || 0);
      dragOY = e.clientY - parseFloat(micEl.style.top  || 0);
      micEl.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    micEl.addEventListener('pointermove', e => {
      if (!micDrag) return;
      pillFixed = true;
      pillX = Math.max(0, Math.min(vw - 92, e.clientX - dragOX));
      pillY = Math.max(0, Math.min(vh - 44, e.clientY - dragOY));
      micEl.style.left = pillX + 'px';
      micEl.style.top  = pillY + 'px';
    });

    micEl.addEventListener('pointerup', e => {
      const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
      if (Math.hypot(dx, dy) < 6) toggleMic();
      micDrag = false;
    });
  }

  async function toggleMic() {
    if (micActive) {
      micActive = false;
      micEl.dataset.active = 'false';
      micLbl.textContent = 'speak';
      chrome.runtime.sendMessage({ type: 'STOP_MIC' }).catch(() => {});
      if (state === 'listening') applyState('idle');
    } else {
      // Create AudioContext here — must be inside a user gesture (pointer click)
      ensureAudioCtx();

      // Full connection setup — exactly like sidepanel mic button
      const { gemini_key, groq_key } = await chrome.storage.local.get(['gemini_key', 'groq_key']);
      if (!gemini_key || !groq_key) {
        enqueue('Open panel → set API keys first!', 'speech', 3500);
        return;
      }
      micActive = true;
      micEl.dataset.active = 'true';
      micLbl.textContent = 'connecting…';
      applyState('listening');

      try {
        await chrome.runtime.sendMessage({ type: 'DISCONNECT_WEBSOCKET' });
        await chrome.runtime.sendMessage({ type: 'CONNECT_WEBSOCKET', apiKey: gemini_key });
        await chrome.runtime.sendMessage({ type: 'START_MIC' });
      } catch (e) {
        micActive = false;
        micEl.dataset.active = 'false';
        micLbl.textContent = 'speak';
        enqueue('Failed to start mic 😞', 'speech', 2500);
        applyState('idle');
      }
    }
  }

  function updateMicPos() {
    const muteEl = shadow.getElementById('ctrl-mute');
    if (!pillFixed) {
      micEl.style.left = (pos.x + ROBOT_W / 2 - 38).toFixed(0) + 'px';
      micEl.style.top  = (pos.y + ROBOT_H + 5).toFixed(0) + 'px';
    }
    if (muteEl) {
      const micLeft = parseFloat(micEl.style.left) || 0;
      const micTop  = parseFloat(micEl.style.top)  || 0;
      muteEl.style.left = (micLeft + 84).toFixed(0) + 'px';
      muteEl.style.top  = (micTop + 6).toFixed(0) + 'px';
      // Stop button sits to the left of mute
      const stopEl = shadow.getElementById('ctrl-stop');
      if (stopEl) {
        stopEl.style.left = (micLeft - 22).toFixed(0) + 'px';
        stopEl.style.top  = (micTop + 6).toFixed(0) + 'px';
      }
    }
  }

  // ── ROBOT BODY DRAGGING ────────────────────────────────────────────────
  function setupRobotDrag() {
    robotEl.style.pointerEvents = 'auto';
    robotEl.style.cursor = 'grab';

    robotEl.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      // Don't intercept mic pill clicks
      if (e.target === micEl || micEl.contains(e.target)) return;
      robotDrag = true;
      robotDragMoved = false;
      robotDragStartX = e.clientX;
      robotDragStartY = e.clientY;
      robotDragOX = e.clientX - pos.x;
      robotDragOY = e.clientY - pos.y;
      robotEl.setPointerCapture(e.pointerId);
      robotEl.style.cursor = 'grabbing';
      vx = 0; vy = 0;
      e.stopPropagation();
    });

    robotEl.addEventListener('pointermove', e => {
      if (!robotDrag) return;
      const dx = e.clientX - robotDragStartX;
      const dy = e.clientY - robotDragStartY;
      if (Math.hypot(dx, dy) > 4) robotDragMoved = true;
      if (robotDragMoved) {
        pos.x = Math.max(MARGIN, Math.min(vw - ROBOT_W - MARGIN, e.clientX - robotDragOX));
        pos.y = Math.max(MARGIN, Math.min(vh - ROBOT_H - MARGIN, e.clientY - robotDragOY));
        robotEl.style.transform = `translate(${pos.x.toFixed(1)}px,${pos.y.toFixed(1)}px)`;
      }
    });

    robotEl.addEventListener('pointerup', e => {
      if (!robotDrag) return;
      robotDrag = false;
      robotEl.style.cursor = 'grab';
      if (robotDragMoved) {
        // If dragged to a corner/edge: sad state
        const nearLeft   = pos.x < vw * 0.15;
        const nearRight  = pos.x > vw * 0.78;
        const nearBottom = pos.y > vh * 0.7;
        if ((nearLeft || nearRight) && nearBottom) {
          enterSadCorner();
        } else {
          // Small fling
          vx = (e.clientX - robotDragStartX) * 0.04;
          vy = (e.clientY - robotDragStartY) * 0.04;
        }
      }
      robotDragMoved = false;
    });
  }

  // ── LOOK-AT ────────────────────────────────────────────────────────────
  function lookAt(tx, ty) {
    const cx = pos.x + ROBOT_W / 2;
    const cy = pos.y + ROBOT_H * 0.27;
    const angle = Math.atan2(ty - cy, tx - cx) * (180 / Math.PI);
    headGrp.animate(
      [{ transform: `rotate(${Math.max(-22, Math.min(22, angle * 0.35)).toFixed(1)}deg)` }],
      { duration: 380, fill: 'forwards', easing: 'ease-out' }
    );
  }

  // ── MESSAGE HANDLER ────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(msg => {
    switch (msg.type) {
      case 'ROBOT_STATE': {
        if (isMuted || isSadCorner) break;
        if (msg.state !== 'thinking') applyState(msg.state);
        else if (state !== 'acting') applyState('thinking');
        // Show stop button while agent is busy
        const stopEl = shadow.getElementById('ctrl-stop');
        if (stopEl) {
          stopEl.style.display = (msg.state === 'thinking' || msg.state === 'acting') ? 'block' : 'none';
        }
        break;
      }

      case 'ROBOT_MSG':
        // enqueue already checks isMuted; pass readMs param correctly
        enqueue(msg.text, msg.msgType || msg.bubbleType || 'speech', msg.dur || msg.duration || null);
        break;

      case 'ROBOT_BULB':
        playBulbFlash();
        break;

      case 'ROBOT_ACT_AT':
        if (!isSadCorner && (!msg.ts || Date.now() - msg.ts < 3000)) {
          targetX = msg.x - ROBOT_W / 2;
          targetY = msg.y - ROBOT_H * 0.65;
          if (msg.elementName) enqueue('→ ' + msg.elementName.slice(0, 44), 'action', 1800);
          lookAt(msg.x, msg.y);
        }
        break;

      case 'ROBOT_AUDIO':
        playAudio(msg.data);
        break;

      case 'ROBOT_RESET': {
        applyState('idle');
        targetX = null; targetY = null;
        queue.length = 0;
        hideBubble(); activeMsg = null;
        const stopEl2 = shadow.getElementById('ctrl-stop');
        if (stopEl2) stopEl2.style.display = 'none';
        break;
      }

      case 'MIC_READY':
        micActive = true;
        micEl.dataset.active = 'true';
        micLbl.textContent = 'listening';
        applyState('listening');
        break;

      case 'WEBSOCKET_CONNECTED':
        if (micActive) {
          micLbl.textContent = 'listening';
          applyState('listening');
        }
        break;

      // Agent events — show in speech bubble with context
      case 'AGENT_EVENT': {
        const ev = msg.event;
        if (!ev) break;
        handleAgentEventOnRobot(ev);
        break;
      }
    }
  });

  function handleAgentEventOnRobot(ev) {
    switch (ev.type) {
      case 'SCREEN_ANALYZING':
        enqueue('Looking at the screen…', 'thought', 1800);
        break;
      case 'SCREEN_ANALYZED':
        if (ev.description) enqueue(ev.description.slice(0, 80), 'thought', 2200);
        break;
      case 'PERCEIVING':
        enqueue(`Scanning page… (round ${ev.round})`, 'thought', 1600);
        break;
      case 'ACTION_DENIED':
        enqueue('Hmm, I need permission for that', 'speech', 2500);
        break;
      case 'STEP_DONE':
        enqueue(`Step ${ev.step} done! ✓`, 'shout', 1600);
        break;
      case 'FIELD_QUESTION':
        if (ev.question) enqueue(`❓ ${ev.question.slice(0, 70)}`, 'speech', 5000);
        break;
      case 'TASK_DISPATCHED':
        if (ev.intentText) enqueue(ev.intentText.slice(0, 80), 'shout', 2800);
        break;
    }
  }

  // ── INIT ───────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    setTimeout(mount, 80);
  }

})();
