/* nav.js — rozcestník nástrojov.
 * Zobrazuje vždy práve jednu sekciu (.view) podľa adresy: #/ , #/merge , #/viewer,
 * a obsluhuje tlačidlo na nahratie nových súborov v hornej lište.
 */
(function () {
  "use strict";
  var BRAND = "Mini IFC tools";
  var VIEWS = {
    "":       { el: "view-home",   title: BRAND },
    "merge":  { el: "view-merge",  title: "Zlúčenie IFC modelov", tool: "MergeTool",  reset: "Nahrať nové modely" },
    "viewer": { el: "view-viewer", title: "Prehliadač IFC kódu",  tool: "ViewerTool", reset: "Nahrať nový súbor" }
  };

  function currentKey() {
    var h = (location.hash || "").replace(/^#\/?/, "").trim();
    return VIEWS[h] ? h : "";
  }

  function show() {
    var key = currentKey(), view = VIEWS[key];
    Object.keys(VIEWS).forEach(function (k) {
      var el = document.getElementById(VIEWS[k].el);
      if (el) el.classList.toggle("is-active", k === key);
    });
    var bar = document.getElementById("appbar");
    bar.hidden = key === "";
    document.getElementById("appbarTitle").textContent = view.title;
    document.title = key === "" ? BRAND : view.title + " · " + BRAND;

    var btn = document.getElementById("barReset");
    btn.hidden = !view.reset;
    if (view.reset) btn.textContent = view.reset;
    window.scrollTo(0, 0);
  }

  document.getElementById("barReset").addEventListener("click", function () {
    var view = VIEWS[currentKey()];
    var tool = view && view.tool && window[view.tool];
    if (tool && tool.reset) tool.reset();
  });

  window.addEventListener("hashchange", show);
  show();
})();
