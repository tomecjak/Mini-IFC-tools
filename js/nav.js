/* nav.js — rozcestník nástrojov.
 * Zobrazuje vždy práve jednu sekciu (.view) podľa adresy: #/ , #/merge , #/viewer,
 * plní hornú lištu (názov nástroja, stavový text, štítok) a obsluhuje tlačidlo
 * na nahratie nových súborov.
 *
 * Nástroje si stav v lište prepisujú cez window.AppBar.
 */
(function () {
  "use strict";
  var BRAND = "mini-ifc/tools";
  var VIEWS = {
    // na rozcestníku nie je čo pomenovať — v lište zostane len značka
    "":       { el: "view-home",   slug: "", title: BRAND, sub: "" },
    "merge":  { el: "view-merge",  slug: "merge", cls: "is-merge", title: "Zlúčenie IFC modelov",
                sub: "zlúčenie modelov", tool: "MergeTool",  reset: "nahrať nové modely" },
    "viewer": { el: "view-viewer", slug: "code",  cls: "is-code",  title: "Prehliadač IFC kódu",
                sub: "prehliadač zdrojového kódu", tool: "ViewerTool", reset: "nahrať nový súbor" },
    "validate": { el: "view-validate", slug: "validate", cls: "is-check", title: "Validácia IFC súboru",
                sub: "kontrola súboru", tool: "ValidateTool", reset: "nahrať iný súbor" }
  };

  var elTool  = document.getElementById("barTool");
  var elPipe  = document.querySelector(".bar__pipe");
  var elSub   = document.getElementById("barSub");
  var elBadge = document.getElementById("barBadge");
  var elBack  = document.getElementById("barBack");
  var elReset = document.getElementById("barReset");
  var backFn  = null;

  function currentKey() {
    var h = (location.hash || "").replace(/^#\/?/, "").trim();
    return VIEWS[h] ? h : "";
  }

  // Rozhranie pre nástroje — stavový text a štítok v hornej lište.
  window.AppBar = {
    setStatus: function (text) { elSub.textContent = text || ""; },
    setBadge: function (text) {
      elBadge.hidden = !text;
      elBadge.textContent = text || "";
    },
    /* Tlačidlo návratu k nástroju, z ktorého sa používateľ preklikol.
       Bez popisu sa skryje. Nastavuje ho nástroj vo svojom syncBar(). */
    setBack: function (label, fn) {
      elBack.hidden = !label;
      elBack.textContent = label || "";
      backFn = label ? (fn || null) : null;
    },
    // sloty patria vždy práve zobrazenému nástroju — pri prepnutí sa vyprázdnia
    resetSlots: function () {
      elBadge.hidden = true; elBadge.textContent = "";
      elBack.hidden = true; elBack.textContent = ""; backFn = null;
      var save = document.getElementById("vwSave");
      if (save) save.hidden = true;
    },
    /* Prepnutie na iný nástroj priamo z kódu (napr. preklik nálezu validácie do
       prehliadača kódu). Sekcia sa zobrazí hneď — udalosť hashchange príde až
       po skončení tohto behu a nástroj by dovtedy počítal rozmery nad skrytou
       plochou. Neskoršie druhé zobrazenie už nič nemení. */
    go: function (key) {
      var hash = "#/" + (key || "");
      if (location.hash !== hash) location.hash = hash;
      show();
    }
  };

  // Posun stránky si každá sekcia drží vlastný — po návrate z prekliku je
  // používateľ tam, kde bol, a nie na začiatku dlhého zoznamu nálezov.
  var scrollAt = {};
  var lastKey = null;

  function show() {
    var key = currentKey(), view = VIEWS[key];
    var changed = key !== lastKey;
    if (lastKey !== null && changed) scrollAt[lastKey] = window.scrollY;
    lastKey = key;

    Object.keys(VIEWS).forEach(function (k) {
      var el = document.getElementById(VIEWS[k].el);
      if (el) el.classList.toggle("is-active", k === key);
    });

    elTool.textContent = view.slug;
    elTool.className = "bar__tool" + (view.cls ? " " + view.cls : "");
    elPipe.hidden = !view.slug;      // bez názvu nástroja nemá čo oddeľovať
    document.title = key === "" ? BRAND : view.title + " · " + BRAND;

    // stavové sloty patria vždy práve zobrazenému nástroju
    window.AppBar.resetSlots();
    var tool = view.tool && window[view.tool];
    if (tool && tool.syncBar) tool.syncBar();
    else window.AppBar.setStatus(view.sub);

    elReset.hidden = !view.reset;
    if (view.reset) elReset.textContent = view.reset;
    // to isté zobrazenie druhýkrát (go() a po ňom hashchange) posun neruší
    if (changed) window.scrollTo(0, scrollAt[key] || 0);
  }

  elBack.addEventListener("click", function () { if (backFn) backFn(); });

  elReset.addEventListener("click", function () {
    var view = VIEWS[currentKey()];
    var tool = view && view.tool && window[view.tool];
    if (tool && tool.reset) tool.reset();
  });

  window.addEventListener("hashchange", show);
  show();
})();
