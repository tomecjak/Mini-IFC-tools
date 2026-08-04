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
                sub: "prehliadač zdrojového kódu", tool: "ViewerTool", reset: "nahrať nový súbor" }
  };

  var elTool  = document.getElementById("barTool");
  var elPipe  = document.querySelector(".bar__pipe");
  var elSub   = document.getElementById("barSub");
  var elBadge = document.getElementById("barBadge");
  var elReset = document.getElementById("barReset");

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
    // sloty patria vždy práve zobrazenému nástroju — pri prepnutí sa vyprázdnia
    resetSlots: function () {
      elBadge.hidden = true; elBadge.textContent = "";
      var save = document.getElementById("vwSave");
      if (save) save.hidden = true;
    }
  };

  function show() {
    var key = currentKey(), view = VIEWS[key];
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
    window.scrollTo(0, 0);
  }

  elReset.addEventListener("click", function () {
    var view = VIEWS[currentKey()];
    var tool = view && view.tool && window[view.tool];
    if (tool && tool.reset) tool.reset();
  });

  window.addEventListener("hashchange", show);
  show();
})();
