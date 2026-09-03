(() => {
  "use strict";

  const DATA = window.JACK_MEDIA || { base: "media/", items: [] };
  // "with-me" is the stored id for what's now shown as "With Jon"
  const TAG_LABELS = {
    sleeping:"Sleeping", "with-me":"With Jon", "with-corey":"With Corey",
    loving:"Loving", begging:"Begging", licking:"Licking", vocal:"Screaming",
    blankets:"Blankets", portrait:"Face", playing:"Playing", outdoors:"Outdoors",
    others:"With others", funny:"Funny"
  };
  const SLIDE_MS = 5000;

  const $ = (s) => document.querySelector(s);
  const layer=$("#layer"), cap=$("#cap"), countEl=$("#count"), railI=$("#rail>i");
  const playBtn=$("#play"), hint=$("#hint"), filtersEl=$("#filters"), emptyEl=$("#empty");

  let order = [];       // the current, filtered, balanced play order
  let idx = 0;
  let playing = false;
  let timer = null;
  let filter = "all";
  const nodes = new Map();   // src -> media element
  let currentSrc = null;

  // Encode each path segment so spaces and parens in filenames survive
  const url = (src) => DATA.base + src.split("/").map(encodeURIComponent).join("/");

  if (!DATA.items.length){ emptyEl.hidden = false; return; }

  /* ---------------------------------------------------------------
     Balanced ordering.

     A plain shuffle floods the view with whatever category is biggest
     (600 sleeping photos drown 25 of "with me"). Instead each item gets
     a fractional position within its own tag group — item i of n sits at
     (i + 0.5) / n — and everything is sorted by that. Every group is then
     spread evenly across the whole sequence no matter how large it is.
  --------------------------------------------------------------- */
  function balancedOrder(items){
    const groups = new Map();
    for (const it of items){
      const key = (it.tags && it.tags.length) ? it.tags[0] : "_untagged";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const spread = [];
    for (const list of groups.values()){
      shuffle(list);
      const n = list.length;
      list.forEach((it,i) => spread.push({ it, pos:(i + 0.5)/n, jitter:Math.random()*1e-6 }));
    }
    spread.sort((a,b) => (a.pos - b.pos) || (a.jitter - b.jitter));
    const seq = spread.map(s => s.it);

    // Open on a favourite when there is one
    const firstStar = seq.findIndex(x => x.star);
    if (firstStar > 0) seq.unshift(seq.splice(firstStar,1)[0]);
    return seq;
  }

  function shuffle(a){
    for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  }

  function applyFilter(f){
    filter = f;
    const items = DATA.items.filter(it =>
      f==="all" ? true : f==="star" ? it.star : (it.tags||[]).includes(f));
    order = balancedOrder(items);
    idx = 0;
    [...filtersEl.children].forEach(b => b.classList.toggle("on", b.dataset.f===f));
    nodes.forEach(n => n.remove());
    nodes.clear();
    show(0, true);
  }

  function buildFilters(){
    const counts = {};
    DATA.items.forEach(it => (it.tags||[]).forEach(t => counts[t]=(counts[t]||0)+1));
    const stars = DATA.items.filter(it => it.star).length;

    const chips = [["all", `All ${DATA.items.length}`, ""]];
    if (stars) chips.push(["star", `★ Favorites ${stars}`, "star"]);
    // A filter holding one or two photos isn't worth a chip — it just clutters
    // the bar. Tags earn a chip once there's a real group behind them.
    const MIN_FOR_CHIP = 3;
    Object.keys(counts).filter(t => counts[t] >= MIN_FOR_CHIP)
      .sort((a,b)=>counts[b]-counts[a])
      .forEach(t => chips.push([t, `${TAG_LABELS[t]||t} ${counts[t]}`, ""]));

    // With only one way to slice it, the bar is noise
    if (chips.length < 2) return;
    filtersEl.innerHTML = "";
    chips.forEach(([f,label,cls]) => {
      const b=document.createElement("button");
      b.dataset.f=f; b.textContent=label; if(cls) b.className=cls;
      b.addEventListener("click", () => applyFilter(f));
      filtersEl.appendChild(b);
    });
  }

  function nodeFor(item){
    if (nodes.has(item.src)) return nodes.get(item.src);
    let el;
    if (item.type === "video"){
      el = document.createElement("video");
      el.src = url(item.src);
      el.playsInline = true; el.controls = false; el.preload = "metadata";
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

  function show(i, instant){
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

    const el = nodes.get(item.src);
    if (el.tagName === "VIDEO"){
      el.onended = () => { if (playing) next(); };
      if (playing) el.play().catch(()=>{});
    }
    schedule();
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

  function setPlaying(on){
    playing = on;
    playBtn.textContent = on ? "❚❚" : "▶";
    playBtn.setAttribute("aria-pressed", String(on));
    playBtn.setAttribute("aria-label", on ? "Pause slideshow" : "Play slideshow");
    const el = nodes.get(order[idx].src);
    if (on && el && el.tagName === "VIDEO") el.play().catch(()=>{});
    schedule();
  }

  // --- input ---
  $("#next").addEventListener("click", next);
  $("#prev").addEventListener("click", prev);
  playBtn.addEventListener("click", () => setPlaying(!playing));

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

  buildFilters();
  applyFilter("all");
})();
