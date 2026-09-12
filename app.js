(() => {
  "use strict";

  const DATA = window.JACK_MEDIA || { base: "media/", items: [] };
  const SLIDE_MS = 5000;
  const CHROME_IDLE_MS = 3000;   // while playing, controls fade this long after the last touch
  const NAP_EVERY = 6;           // in mixed views, at most one plain nap in every six photos
  const MIN_FOR_CHIP = 3;

  // Focal drift: each photo slowly eases toward Jack. focus.js holds, per
  // photo, the box he was found in as fractions of the photo [x, y, w, h].
  const FOCUS = window.JACK_FOCUS || {};
  const DRIFT_MS = 6500;         // a touch longer than a slide, so it's still moving when the next one fades in
  const MAX_ZOOM = 1.8;
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The chips offer moods. Each gathers one or more tags, so the bar stays
  // short however finely the photos were tagged. ("with-me" is the stored id
  // for "With Jon".)
  const MOODS = [
    { id:"star",    label:"★ Favorites", cls:"star", test: (it) => !!it.star },
    { id:"jon",     label:"With Jon",    tags:["with-me"] },
    { id:"corey",   label:"With Corey",  tags:["with-corey"] },
    { id:"silly",   label:"Silly",       tags:["funny","licking","vocal"] },
    { id:"loving",  label:"Loving",      tags:["loving","begging"] },
    { id:"sleepy",  label:"Sleepy",      tags:["sleeping","blankets"] },
    { id:"outside", label:"Outside",     tags:["outdoors","playing"] },
  ];

  // Joy weighting. Stars, and the tags that most often earned one, surface
  // sooner. A "plain nap" (asleep, not starred, nothing sweet or silly) is
  // the most common photo and the one least often starred, so it's held back.
  const JOY_TAGS = new Set(["loving","begging","funny","playing","licking","vocal"]);
  const NAP_TAGS = new Set(["sleeping","blankets"]);
  const hasAny = (it, set) => (it.tags || []).some((t) => set.has(t));
  const isNap  = (it) => hasAny(it, NAP_TAGS) && !it.star && !hasAny(it, JOY_TAGS);
  const weight = (it) => (it.star ? 3 : 1) * (hasAny(it, JOY_TAGS) ? 2 : 1) * (isNap(it) ? 0.5 : 1);

  const $ = (s) => document.querySelector(s);
  const layer=$("#layer"), cap=$("#cap"), countEl=$("#count"), railI=$("#rail>i");
  const playBtn=$("#play"), muteBtn=$("#mute"), hint=$("#hint"), filtersEl=$("#filters"), emptyEl=$("#empty");

  let order = [];            // this visit's play order for the current mood
  let idx = 0;
  let playing = false;
  let timer = null;
  let filter = "all";
  const nodes = new Map();   // src -> media element
  let currentSrc = null;

  // Encode each path segment so spaces and parens in filenames survive
  const url = (src) => DATA.base + src.split("/").map(encodeURIComponent).join("/");

  if (!DATA.items.length){ emptyEl.hidden = false; return; }

  // Forgiving local storage — a private window or a full disk can refuse it
  const store = {
    get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch(e){ return d; } },
    set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
  };
  const SHOWN_KEY = "jack.shown.v1", SOUND_KEY = "jack.sound.v1";

  /* ---------------------------------------------------------------
     No repeats between visits. Each phone remembers which photos it has
     shown; every visit starts with ones it hasn't, and nothing comes back
     until everything else has had its turn. Plain naps run their own
     round, so holding them back never stalls the rest from cycling.
  --------------------------------------------------------------- */
  const known = new Set(DATA.items.map((it) => it.src));
  const shown = new Set(store.get(SHOWN_KEY, []).filter((s) => known.has(s)));
  let shownSaveTimer = null;
  const saveShown = () => store.set(SHOWN_KEY, [...shown]);
  function markShown(src){
    if (shown.has(src)) return;
    shown.add(src);
    clearTimeout(shownSaveTimer);
    shownSaveTimer = setTimeout(saveShown, 500);
  }
  addEventListener("pagehide", saveShown);

  function startNewRoundsWhereFinished(){
    const naps = DATA.items.filter(isNap), rest = DATA.items.filter((it) => !isNap(it));
    for (const pool of [naps, rest]){
      if (pool.length && pool.every((it) => shown.has(it.src))) pool.forEach((it) => shown.delete(it.src));
    }
    saveShown();
  }

  // Weighted shuffle: each photo draws random^(1/weight), so heavier ones
  // tend to land earlier while everything still gets a turn.
  function weightedShuffle(list){
    return list.map((it) => ({ it, k: Math.pow(Math.random(), 1 / weight(it)) }))
               .sort((a, b) => b.k - a.k).map((x) => x.it);
  }
  const freshFirst = (list) =>
    weightedShuffle(list.filter((it) => !shown.has(it.src)))
      .concat(weightedShuffle(list.filter((it) => shown.has(it.src))));

  function buildOrder(items){
    const naps = items.filter(isNap), rest = items.filter((it) => !isNap(it));
    let seq;
    if (!rest.length || naps.length >= rest.length){
      seq = freshFirst(items);                  // a mostly-nap view, like Sleepy, is left as is
    } else {
      const a = freshFirst(rest), b = freshFirst(naps);
      seq = [];
      while (a.length || b.length){
        const napTurn = seq.length % NAP_EVERY === NAP_EVERY - 1;
        seq.push(napTurn && b.length ? b.shift() : a.length ? a.shift() : b.shift());
      }
    }
    // Open on a favorite this phone hasn't shown yet this round
    const s = seq.findIndex((it) => it.star && !shown.has(it.src));
    if (s > 0 && s < 25) seq.unshift(seq.splice(s, 1)[0]);
    return seq;
  }

  function itemsFor(id){
    const m = MOODS.find((x) => x.id === id);
    if (!m) return DATA.items;
    return DATA.items.filter(m.test || ((it) => (it.tags || []).some((t) => m.tags.includes(t))));
  }

  function applyFilter(f){
    filter = f;
    startNewRoundsWhereFinished();
    order = buildOrder(itemsFor(f));
    idx = 0;
    [...filtersEl.children].forEach((b) => b.classList.toggle("on", b.dataset.f === f));
    nodes.forEach((n) => n.remove());
    nodes.clear();
    show(0);
  }

  function buildFilters(){
    const chips = [{ id:"all", label:"All" }]
      .concat(MOODS.filter((m) => itemsFor(m.id).length >= MIN_FOR_CHIP));
    if (chips.length < 2) return;
    filtersEl.innerHTML = "";
    chips.forEach((c) => {
      const b = document.createElement("button");
      b.dataset.f = c.id; b.textContent = c.label;
      if (c.cls) b.className = c.cls;
      b.addEventListener("click", () => applyFilter(c.id));
      filtersEl.appendChild(b);
    });
  }

  /* ---- sound: browsers keep videos silent until the first touch; after
          that they follow the mute button, which this phone remembers ---- */
  const ICON_SOUND = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12"/></svg>';
  const ICON_MUTED = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>';
  let soundOn = store.get(SOUND_KEY, true) !== false;
  let gestured = false;
  const videoMuted = () => !soundOn || !gestured;
  function applySound(){
    nodes.forEach((n) => { if (n.tagName === "VIDEO") n.muted = videoMuted(); });
    muteBtn.innerHTML = soundOn ? ICON_SOUND : ICON_MUTED;
    muteBtn.setAttribute("aria-pressed", String(!soundOn));
    muteBtn.setAttribute("aria-label", soundOn ? "Mute videos" : "Unmute videos");
  }
  // click/touchend/keydown are the events that count as a real touch for the
  // browser's sound rule; capture so it's settled before any other handler runs
  function firstGesture(){ if (gestured) return; gestured = true; applySound(); }
  ["click","touchend","keydown"].forEach((ev) => addEventListener(ev, firstGesture, { capture:true, passive:true }));
  function toggleSound(){ soundOn = !soundOn; store.set(SOUND_KEY, soundOn); applySound(); }

  function nodeFor(item){
    if (nodes.has(item.src)) return nodes.get(item.src);
    let el;
    if (item.type === "video"){
      el = document.createElement("video");
      el.src = url(item.src);
      el.playsInline = true; el.controls = false; el.preload = "metadata";
      el.muted = videoMuted();
      el.setAttribute("webkit-playsinline","");
      // Without a poster a paused clip is just a black rectangle
      if (item.poster) el.poster = url(item.poster);
    } else {
      el = document.createElement("img");
      el.src = url(item.src);
      el.alt = item.caption || "Jack";
      el.decoding = "async";
    }
    nodes.set(item.src, el);
    layer.appendChild(el);
    // Don't let the cache grow without bound on a long sitting — but never evict
    // what's on screen (or what we're preloading), or the view goes blank.
    if (nodes.size > 12){
      for (const k of nodes.keys()){
        if (k !== item.src && k !== currentSrc){ nodes.get(k).remove(); nodes.delete(k); break; }
      }
    }
    return el;
  }

  function show(i){
    if (!order.length) return;
    idx = (i + order.length) % order.length;
    const item = order[idx];
    currentSrc = item.src;

    nodeFor(item);
    if (order[idx+1]) nodeFor(order[idx+1]);   // preload the next one

    nodes.forEach((n, src) => {
      const on = src === item.src;
      n.classList.toggle("on", on);
      if (n.tagName === "VIDEO"){
        if (on) n.currentTime = 0; else n.pause();
      }
    });

    cap.textContent = item.caption || "";
    countEl.textContent = `${idx+1} / ${order.length}`;
    railI.style.width = (100*(idx+1)/order.length) + "%";
    markShown(item.src);

    const el = nodes.get(item.src);
    if (el.tagName === "IMG"){
      if (el.complete && el.naturalWidth) drift(el, item);
      else el.addEventListener("load", () => { if (currentSrc === item.src) drift(el, item); }, { once:true });
    }
    if (el.tagName === "VIDEO"){
      // Clips always play when they come up. Browsing by hand, they loop;
      // in the slideshow they move on when they finish.
      const stuck = () => { if (playing && order[idx] === item){ clearTimeout(timer); timer = setTimeout(next, SLIDE_MS); } };
      el.muted = videoMuted();
      el.loop = !playing;
      el.onended = () => { if (playing) next(); };
      el.onerror = stuck;
      el.play().catch(stuck);
    }
    schedule();
  }

  /* ---------------------------------------------------------------
     Slowly ease from the whole photo toward Jack. The zoom is chosen so the
     box he was found in ends up filling most of the screen (capped, so it
     stays calm), and the pan toward him grows with the zoom — a close-up
     barely moves, a far-off shot glides in. Photos where he wasn't found
     get a gentle drift to the middle. Videos and gifs are left alone.
  --------------------------------------------------------------- */
  function drift(el, item){
    el.style.transition = "opacity .6s ease";
    el.style.transform = "none";
    if (reduceMotion || item.type === "video" || /\.gif$/i.test(item.src)) return;
    const W = el.naturalWidth, H = el.naturalHeight;
    const vw = layer.clientWidth, vh = layer.clientHeight;
    if (!W || !H || !vw || !vh) return;
    const c = Math.min(vw / W, vh / H);                  // the "contain" fit
    const ox = (vw - W * c) / 2, oy = (vh - H * c) / 2;  // letterbox offsets
    const f = FOCUS[item.src];
    let cx = vw / 2, cy = vh / 2, z = 1.08;
    if (f){
      const [fx, fy, fw, fh] = f;
      cx = ox + (fx + fw / 2) * W * c;
      cy = oy + (fy + fh / 2) * H * c;
      z = Math.min((vw * 0.9) / (fw * W * c), (vh * 0.9) / (fh * H * c));
    }
    z = Math.min(MAX_ZOOM, Math.max(1.04, z));          // even a close-up breathes a little
    const k = Math.min(1, (z - 1) / 0.6);                // how far to bring him toward centre
    const px = cx + k * (vw / 2 - cx), py = cy + k * (vh / 2 - cy);
    void el.offsetWidth;                                 // commit the reset before animating
    el.style.transition = `opacity .6s ease, transform ${DRIFT_MS}ms cubic-bezier(.33,.1,.3,1)`;
    el.style.transform = `translate(${px - z * cx}px, ${py - z * cy}px) scale(${z})`;
  }

  function schedule(){
    clearTimeout(timer);
    if (!playing) return;
    const el = nodes.get(order[idx].src);
    if (el && el.tagName === "VIDEO") return;   // videos advance when they end
    timer = setTimeout(next, SLIDE_MS);
  }

  const next = () => show(idx+1);
  const prev = () => show(idx-1);

  // Keep the screen on while the slideshow plays. Android Chrome supports this
  // over https. The browser drops the lock whenever the app is hidden, so it's
  // re-requested when the app comes back to the front.
  let wakeLock = null;
  async function keepAwake(on){
    try{
      if (on && "wakeLock" in navigator && document.visibilityState === "visible"){
        if (!wakeLock){
          wakeLock = await navigator.wakeLock.request("screen");
          wakeLock.addEventListener("release", () => { wakeLock = null; });
        }
      } else if (!on && wakeLock){
        await wakeLock.release();
        wakeLock = null;
      }
    }catch(e){
      wakeLock = null;   // e.g. battery saver refused it — the slideshow still runs
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && playing) keepAwake(true);
  });

  // While the slideshow plays, the controls fade after a few seconds so it's
  // just Jack. Any touch brings them back.
  let idleTimer = null;
  function wakeChrome(){
    document.body.classList.remove("immersive");
    clearTimeout(idleTimer);
    if (playing) idleTimer = setTimeout(() => document.body.classList.add("immersive"), CHROME_IDLE_MS);
  }
  ["pointerdown","pointermove","keydown"].forEach((ev) => addEventListener(ev, wakeChrome, { passive:true }));

  function setPlaying(on){
    playing = on;
    keepAwake(on);
    playBtn.textContent = on ? "❚❚" : "▶";
    playBtn.setAttribute("aria-pressed", String(on));
    playBtn.setAttribute("aria-label", on ? "Pause slideshow" : "Play slideshow");
    const el = nodes.get(order[idx].src);
    if (el && el.tagName === "VIDEO"){ el.loop = !on; el.play().catch(()=>{}); }
    schedule();
    wakeChrome();
  }

  // --- input ---
  $("#next").addEventListener("click", next);
  $("#prev").addEventListener("click", prev);
  playBtn.addEventListener("click", () => setPlaying(!playing));
  muteBtn.addEventListener("click", toggleSound);

  let sx=null, sy=null;
  addEventListener("touchstart", e => { sx=e.touches[0].clientX; sy=e.touches[0].clientY; }, {passive:true});
  addEventListener("touchend", e => {
    if (sx===null) return;
    const dx=e.changedTouches[0].clientX-sx, dy=e.changedTouches[0].clientY-sy;
    if (Math.abs(dx)>50 && Math.abs(dx)>Math.abs(dy)) (dx<0 ? next() : prev());
    sx=sy=null;
  }, {passive:true});

  addEventListener("keydown", e => {
    if (e.key==="ArrowRight") next();
    else if (e.key==="ArrowLeft") prev();
    else if (e.key===" "){ e.preventDefault(); setPlaying(!playing); }
    else if (e.key==="m" || e.key==="M") toggleSound();
  });

  let hidden=false;
  const hideHint=()=>{ if(hidden) return; hidden=true; hint.style.opacity="0"; };
  ["click","touchstart","keydown"].forEach(ev => addEventListener(ev, hideHint, {once:true, passive:true}));
  setTimeout(hideHint, 4500);

  // Offline caching belongs to the deployed https site. During local testing a
  // stale worker would sit in front of every request and serve dead cache
  // entries, so here we actively tear any of them down instead.
  if ("serviceWorker" in navigator){
    if (location.protocol === "https:"){
      addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(()=>{}));
    } else {
      navigator.serviceWorker.getRegistrations()
        .then(rs => rs.forEach(r => r.unregister())).catch(()=>{});
      if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(()=>{});
    }
  }

  // Start: a long-press shortcut can ask for a mood (?mood=corey). The
  // slideshow starts on its own unless the link says ?play=0.
  const params = new URLSearchParams(location.search);
  const wanted = params.get("mood");
  buildFilters();
  applySound();
  applyFilter(MOODS.some((m) => m.id === wanted) ? wanted : "all");
  if (params.get("play") !== "0") setPlaying(true);
})();
