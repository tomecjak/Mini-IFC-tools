/* nav.js — rozcestník nástrojov.
 * Zobrazuje vždy práve jednu sekciu (.view) podľa adresy: #/ , #/merge , #/viewer.
 */
(function () {
  "use strict";
  var VIEWS = {
    "":       { el: "view-home",   title: "IFC nástroje" },
    "merge":  { el: "view-merge",  title: "Zlúčenie IFC modelov" },
    "viewer": { el: "view-viewer", title: "Prehliadač IFC kódu" }
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
    document.title = key === "" ? "IFC nástroje" : view.title + " · IFC nástroje";
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", show);
  show();
})();
