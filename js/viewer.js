/* viewer.js — rozhranie prehliadača IFC kódu.
 * Načíta súbor, dá ho zaindexovať jadru js/ifc-code.js a zobrazí zdrojový kód
 * s farebným zvýraznením. Vykresľujú sa len viditeľné riadky (virtualizácia),
 * takže nástroj zvládne aj súbory so stovkami tisíc riadkov.
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var C = window.IFCCode;
  var ROW_H = 20;          // výška riadku v px (musí sedieť s .cl v styles.css)
  var PAD = 34;            // vodorovné odsadenie kódu
  var HIT_LIMIT = 5000;    // strop pre počet nájdených riadkov

  var st = {
    name: "", size: 0, idx: null,
    visible: null,        // Int32Array indexov riadkov, alebo null = všetky
    filter: null,         // Set vybraných tried, alebo null = bez filtra
    sel: -1,              // vybraný príkaz (index do stmt polí)
    hits: [], hitPos: -1, // nájdené riadky (pozície vo viditeľnom zozname)
    hist: [],             // história preklikov v paneli detailu
    typeQuery: "",        // text v poli „Nájsť triedu…“
    typeShown: null,      // triedy práve ponúknuté v zozname (v poradí zobrazenia)
    origArgs: new Map(),  // "príkaz:argument" → pôvodný zápis (kvôli vráteniu zmeny)
    editedStmts: new Set(),
    onlyEdited: false,    // prepínač „Upravené“ v hornej lište
    catCache: new Map(),
    charW: 7.53,
    from: -1, to: -1      // aktuálne vykreslené okno
  };

  var esc = C.esc;

  // ---- kategória triedy (farba) — počíta sa raz pre každý typ ---------------
  function catOf(type) {
    if (!type) return "other";
    var c = st.catCache.get(type);
    if (c) return c;
    var sample = st.idx && st.idx.typeSample.get(type);
    c = C.categoryOf(type, sample != null ? st.idx.stmtBody(sample) : null);
    st.catCache.set(type, c);
    return c;
  }

  // =========================================================================
  //  Načítanie súboru
  // =========================================================================
  var UPLOAD_ICON = '<svg class="drop__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4m0 0L7 9m5-5l5 5"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/></svg>';

  function renderDrop(errorMsg) {
    $("vwHead").hidden = false;      // úvodný popis nástroja
    $("vwPanel").hidden = false;
    $("vwApp").hidden = true;
    $("vwSub").textContent = "";
    $("vwBody").innerHTML =
      '<div class="drop" id="vwDrop">' + UPLOAD_ICON +
        '<div class="drop__main">Presuňte sem IFC súbor</div>' +
        '<div class="drop__hint">alebo kliknite pre výber · formát <b>.ifc</b> · súbor zostáva vo vašom počítači</div>' +
        (errorMsg ? '<div class="errline">' + esc(errorMsg) + "</div>" : "") +
      "</div>";
    var dz = $("vwDrop");
    dz.addEventListener("click", function () { $("fileV").click(); });
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("is-over"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("is-over"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault(); dz.classList.remove("is-over");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
  }

  function progress(label, pct) {
    $("vwBody").innerHTML =
      '<div class="drop drop--busy">' +
        '<div class="spinner" style="border-color:rgba(0,0,0,.15);border-top-color:#0E5A8A"></div>' +
        '<div class="drop__main" style="margin-top:10px">' + esc(label) + "</div>" +
        '<div class="pbar"><i style="width:' + Math.round(pct * 100) + '%"></i></div>' +
      "</div>";
  }

  function handleFile(file) {
    st.name = file.name; st.size = file.size;
    progress("Čítam " + file.name + "…", 0.05);
    var reader = new FileReader();
    reader.onload = function () {
      progress("Analyzujem štruktúru súboru…", 0.1);
      C.indexFile(reader.result, function (p) { progress("Analyzujem štruktúru súboru…", 0.1 + p * 0.9); })
        .then(function (idx) {
          if (!idx.entityCount) throw new Error("V súbore sa nenašli žiadne IFC entity (#ID = TRIEDA(...)).");
          st.idx = idx; st.catCache = new Map();
          startViewer();
        })
        .catch(function (err) { renderDrop("Súbor sa nepodarilo spracovať: " + err.message); });
    };
    reader.onerror = function () { renderDrop("Chyba pri čítaní súboru."); };
    reader.readAsText(file);
  }

  // =========================================================================
  //  Spustenie prehliadača nad načítaným súborom
  // =========================================================================
  function startViewer() {
    var idx = st.idx;
    st.visible = null; st.filter = null; st.sel = -1;
    st.hits = []; st.hitPos = -1; st.hist = []; st.from = st.to = -1;
    st.origArgs = new Map(); st.editedStmts = new Set(); st.onlyEdited = false;
    updateSave();

    $("vwHead").hidden = true;       // po načítaní súboru je popis zbytočný, kód dostane viac miesta
    $("vwPanel").hidden = true;
    $("vwApp").hidden = false;
    $("vwFile").textContent = st.name;
    $("vwChips").innerHTML =
      '<span class="chip">schéma <b>' + esc(idx.schema) + "</b></span>" +
      (idx.lengthUnit !== "?" ? '<span class="chip">jednotka <b>' + esc(idx.lengthUnit) + "</b></span>"
                              : '<span class="chip chip--warn">jednotka neurčená</span>') +
      '<span class="chip"><b>' + idx.entityCount.toLocaleString("sk-SK") + "</b> entít</span>" +
      '<span class="chip"><b>' + idx.types.length + "</b> tried</span>" +
      '<span class="chip"><b>' + idx.lineCount.toLocaleString("sk-SK") + "</b> riadkov</span>" +
      '<span class="chip">' + Math.round(st.size / 1024).toLocaleString("sk-SK") + " kB</span>";

    measureChar();
    $("vwTypeQ").value = "";
    st.typeQuery = ""; st.typeShown = null;
    renderTypeList("");
    layout();
    render(true);
    showEmptyDetail();
    // prvá entita ako úvodná ukážka
    if (idx.stmtIds.length) {
      for (var i = 0; i < idx.stmtIds.length; i++) {
        if (idx.stmtIds[i] >= 0) { selectStmt(i, false, false); break; }
      }
    }
  }

  function measureChar() {
    var probe = document.createElement("span");
    probe.className = "lc";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;padding:0";
    probe.textContent = "0123456789012345678901234567890123456789";
    $("vwCanvas").appendChild(probe);
    var w = probe.getBoundingClientRect().width / 40;
    probe.remove();
    if (w > 2) st.charW = w;
  }

  function layout() {
    var rows = visCount();
    var canvas = $("vwCanvas");
    canvas.style.height = (rows * ROW_H) + "px";
    var need = PAD + Math.min(st.idx.maxLen, 4000) * st.charW;
    canvas.style.width = Math.max(need, $("vwCode").clientWidth) + "px";
  }

  // ---- viditeľné riadky ----------------------------------------------------
  function visCount() { return st.visible ? st.visible.length : st.idx.lineCount; }
  function lineOfRow(r) { return st.visible ? st.visible[r] : r; }
  // Pozícia riadku vo viditeľnom zozname, alebo -1 ak ho skrýva filter.
  function rowOfLine(line) {
    if (!st.visible) return line;
    var lo = 0, hi = st.visible.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, v = st.visible[mid];
      if (v === line) return mid;
      if (v < line) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  function applyFilter() {
    var idx = st.idx;
    var byType = st.filter && st.filter.size;
    if (!byType && !st.onlyEdited) st.visible = null;
    else {
      var buf = [];
      for (var i = 0; i < idx.lineCount; i++) {
        var s = idx.lineStmt[i];
        if (s < 0) continue;
        if (byType && !st.filter.has(idx.stmtTypes[s])) continue;
        if (st.onlyEdited && !st.editedStmts.has(s)) continue;
        buf.push(i);
      }
      st.visible = Int32Array.from(buf);
    }
    st.from = st.to = -1;
    layout();
    $("vwCode").scrollTop = 0;
    render(true);
    runSearch();      // hity sa počítajú len z viditeľných riadkov
    updateFilterLabel();
  }

  // =========================================================================
  //  Vykresľovanie kódu (virtualizácia)
  // =========================================================================
  function render(force) {
    if (!st.idx) return;
    var idx = st.idx, code = $("vwCode");
    var rows = visCount();
    var first = Math.max(0, Math.floor(code.scrollTop / ROW_H) - 12);
    var last = Math.min(rows - 1, first + Math.ceil(code.clientHeight / ROW_H) + 24);
    if (!force && first === st.from && last === st.to) return;
    st.from = first; st.to = last;

    var html = "";
    for (var r = first; r <= last; r++) {
      var li = lineOfRow(r);
      var line = idx.lines[li];
      var s = idx.lineStmt[li];
      var isStart = s >= 0 && idx.stmtFrom[s] === li && idx.stmtIds[s] >= 0;
      var cls = "cl";
      if (s >= 0 && st.editedStmts.has(s)) cls += " is-edited";
      if (s >= 0 && s === st.sel) cls += " is-sel";
      if (st.hitLines && st.hitLines.has(li)) cls += (st.hitPos >= 0 && lineOfRow(st.hits[st.hitPos]) === li) ? " is-cur" : " is-hit";
      html += '<div class="' + cls + '" style="top:' + (r * ROW_H) + 'px" data-line="' + li + '">' +
                '<span class="lc">' +
                  C.tokenizeLine(line, {
                    inString: !!idx.startsInStr[li],
                    isStart: isStart,
                    mainCat: "kc-" + (s >= 0 ? catOf(idx.stmtTypes[s]) : "other")
                  }) +
                "</span>" +
              "</div>";
    }
    $("vwRows").innerHTML = html;
  }

  function scrollToRow(r, center) {
    var code = $("vwCode");
    var y = r * ROW_H;
    if (center) code.scrollTop = Math.max(0, y - code.clientHeight / 2);
    else if (y < code.scrollTop + ROW_H * 2 || y > code.scrollTop + code.clientHeight - ROW_H * 3) {
      code.scrollTop = Math.max(0, y - code.clientHeight / 3);
    }
    render(true);
  }

  // =========================================================================
  //  Výber entity a panel detailu
  // =========================================================================
  function selectStmt(sIdx, push, scroll) {
    if (sIdx == null || sIdx < 0) return;
    if (push && st.sel >= 0 && st.sel !== sIdx) st.hist.push(st.sel);
    st.sel = sIdx;
    if (scroll !== false) {
      var r = rowOfLine(st.idx.stmtFrom[sIdx]);
      if (r >= 0) scrollToRow(r, true);
    }
    render(true);
    renderDetail(sIdx);
  }

  function selectId(id, push) {
    var s = st.idx.byId.get(id);
    if (s == null) return;
    selectStmt(s, push !== false, true);
  }

  function showEmptyDetail() {
    $("vwSide").innerHTML =
      '<div class="dt dt--empty">' +
        "<p>Kliknite na ktorýkoľvek riadok kódu.</p>" +
        "<p>Zobrazí sa rozpis atribútov entity podľa IFC schémy, jej property sety a zoznam entít, ktoré sa na ňu odkazujú.</p>" +
      "</div>";
  }

  function entityLabel(sIdx) {
    var idx = st.idx, type = idx.stmtTypes[sIdx];
    var args = C.splitArgs(idx.stmtBody(sIdx));
    var nm = "";
    if (args.length >= 3 && /^'[0-9A-Za-z_$]{22}'$/.test((args[0] || "").trim()) && (args[2] || "")[0] === "'") {
      nm = C.decodeIfcText(args[2]);
    } else if ((args[0] || "")[0] === "'" && /^IFC(MATERIAL|PROPERTY|QUANTITY)/.test(type)) {
      nm = C.decodeIfcText(args[0]);
    }
    return { type: type, name: nm, args: args };
  }

  // ---- odkazy do dokumentácie buildingSMART --------------------------------
  // Verzia dokumentácie sa riadi schémou zo súboru (FILE_SCHEMA).
  function docInfo(type) {
    return window.IFCDocs && st.idx ? window.IFCDocs.docFor(type, st.idx.schema) : null;
  }
  function docLink(type, cls, text) {
    var label = esc(text || type), d = docInfo(type);
    if (!d) return '<span class="' + cls + '" title="Táto trieda nie je v dokumentácii buildingSMART">' + label + "</span>";
    return '<a class="' + cls + ' doclink" href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer" title="' +
             "Otvoriť dokumentáciu buildingSMART · " + esc(d.label) +
             (d.exact ? "" : " — trieda nie je v schéme tohto súboru") + '">' +
             label + '<span class="doclink__x" aria-hidden="true">↗</span></a>';
  }
  // Upozornenie, že odkaz vedie do dokumentácie inej verzie IFC, než hlási súbor.
  // Pri zhode so schémou súboru sa nič nezobrazuje — to je bežný stav.
  function docNote(type) {
    var d = docInfo(type);
    if (!d || d.exact) return "";
    return '<span class="dt__doc is-other" title="Táto trieda v schéme súboru nie je">' +
           esc(d.label) + " · iná verzia</span>";
  }

  function refChip(id) {
    var s = st.idx.byId.get(id);
    if (s == null) return '<span class="reflink is-dead" title="cieľ neexistuje">#' + id + "</span>";
    var l = entityLabel(s);
    return '<button class="reflink kc-' + catOf(l.type) + '" data-goid="' + id + '">' +
             "#" + id + ' <span class="rl__t">' + esc(l.type.replace(/^IFC/, "")) + "</span>" +
             (l.name ? ' <span class="rl__n">' + esc(trunc(l.name, 26)) + "</span>" : "") +
           "</button>";
  }
  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /* Vykreslenie hodnoty. hideType=true potlačí názov dátového typu, v ktorom je
     hodnota zabalená (v tabuľke property setov je zbytočný). */
  function valHTML(raw, depth, hideType) {
    var v = (raw == null ? "" : String(raw)).trim();
    depth = depth || 0;
    if (v === "") return '<i class="t-nil">—</i>';
    if (v === "$") return '<i class="t-nil">nezadané</i>';
    if (v === "*") return '<i class="t-nil">odvodené (*)</i>';
    if (/^#\d+$/.test(v)) return refChip(+v.slice(1));
    if (v[0] === "'") return '<span class="t-str">' + esc(C.decodeIfcText(v)) + "</span>";
    if (/^\.[A-Za-z_][A-Za-z0-9_]*\.$/.test(v)) return '<span class="t-enum">' + esc(v.slice(1, -1)) + "</span>";
    if (v[0] === "(") {
      var items = C.splitTopLevel(v.slice(1, v.length - 1));
      if (!items.length) return '<i class="t-nil">prázdny zoznam</i>';
      var allRefs = items.every(function (x) { return /^#\d+$/.test(x); });
      if (allRefs && depth === 0) {
        var shown = items.slice(0, 12).map(function (x) { return refChip(+x.slice(1)); }).join("");
        return '<span class="cnt">' + items.length + ' položiek</span><div class="vlist">' + shown +
               (items.length > 12 ? '<span class="more">+ ' + (items.length - 12) + " ďalších</span>" : "") + "</div>";
      }
      return '<span class="cnt">' + items.length + " položiek</span> " +
             '<span class="t-num">' + esc(trunc(v, 160)) + "</span>";
    }
    var m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(v);
    if (m) return valHTML(m[2], depth + 1, hideType) +
                  (hideType ? "" : ' <span class="wrapt">' + esc(m[1]) + "</span>");
    if (/^[-+.\d]/.test(v)) return '<span class="t-num">' + esc(v) + "</span>";
    return esc(v);
  }

  // Príkazy, ktoré sa odkazujú na dané #ID (prehľadanie riadkov, bez indexu).
  function findReferrers(id, self, cap) {
    var idx = st.idx, needle = "#" + id, out = [], seen = new Set();
    for (var i = 0; i < idx.lineCount && out.length < cap; i++) {
      var line = idx.lines[i], p = line.indexOf(needle);
      while (p >= 0) {
        var after = line.charCodeAt(p + needle.length);
        if (!(after >= 48 && after <= 57)) {
          var s = idx.lineStmt[i];
          if (s >= 0 && s !== self && !seen.has(s)) { seen.add(s); out.push(s); }
          break;
        }
        p = line.indexOf(needle, p + 1);
      }
    }
    return out;
  }

  // Property sety a veličiny naviazané na vybraný objekt.
  function psetsFor(sIdx, referrers) {
    var idx = st.idx, out = [];
    var myId = idx.stmtIds[sIdx];
    var mine = new RegExp("#" + myId + "(?![0-9])");
    referrers.forEach(function (r) {
      if (idx.stmtTypes[r] !== "IFCRELDEFINESBYPROPERTIES") return;
      var a = C.splitArgs(idx.stmtBody(r));
      var related = a[4] || "", pset = (a[5] || "").trim();
      if (!mine.test(related)) return;
      var pi = /^#(\d+)$/.exec(pset) ? idx.byId.get(+pset.slice(1)) : null;
      if (pi == null) return;
      var pa = C.splitArgs(idx.stmtBody(pi));
      var ptype = idx.stmtTypes[pi];
      var listRaw = ptype === "IFCELEMENTQUANTITY" ? (pa[5] || "") : (pa[4] || "");
      var props = [];
      C.splitTopLevel(listRaw.replace(/^\(|\)$/g, "")).forEach(function (ref) {
        var mm = /^#(\d+)$/.exec(ref.trim());
        if (!mm) return;
        var qi = idx.byId.get(+mm[1]);
        if (qi == null) return;
        var qa = C.splitArgs(idx.stmtBody(qi)), qt = idx.stmtTypes[qi];
        var value = qt === "IFCPROPERTYSINGLEVALUE" ? qa[2]
                  : /^IFCQUANTITY/.test(qt) ? qa[3]
                  : qt === "IFCPROPERTYENUMERATEDVALUE" ? qa[2]
                  : qt === "IFCPROPERTYLISTVALUE" ? qa[2]
                  : qa[2];
        props.push({ name: C.decodeIfcText(qa[0] || ""), value: value, id: +mm[1], type: qt });
      });
      out.push({ name: C.decodeIfcText(pa[2] || ""), id: idx.stmtIds[pi], type: ptype, props: props });
    });
    return out;
  }

  function renderDetail(sIdx) {
    var idx = st.idx, side = $("vwSide");
    var id = idx.stmtIds[sIdx], type = idx.stmtTypes[sIdx];
    var body = idx.stmtBody(sIdx);
    var args = C.splitArgs(body);
    var cat = catOf(type);
    var an = C.attrNames(type, args, idx.schema);
    // odkiaľ sú názvy atribútov — pri inej verzii schémy alebo odhade to treba povedať
    var anNote = an.exact ? ""
      : an.version ? ' <span class="dt__doc is-other" title="Táto trieda nie je v schéme súboru, názvy sú z inej verzie IFC">názvy podľa ' + esc(an.version) + "</span>"
                   : ' <span class="dt__doc is-other" title="Trieda nie je v žiadnej podporovanej schéme IFC — názvy sú odhadnuté podľa štruktúry entity">odhad</span>';

    var rows = args.map(function (a, i) {
      var nm = an.names[i];
      var info = C.classifyValue(a);
      var ki = kindAt(an, i);
      var can = canEdit(info, nm, ki, a);
      var changed = st.origArgs.has(sIdx + ":" + i);
      var tip = "Upraviť hodnotu" + (ki && KIND_LABEL[ki.kind] ? " (" + KIND_LABEL[ki.kind] + ")" : "");
      var vh = valHTML(a);
      // dátový typ sa píše za hodnotu; ak už hodnota nesie vlastný obal
      // (napr. IFCLABEL('W-01')), deklarovaný typ sa neopakuje
      var dtype = an.types && an.types[i];
      var typeHTML = (dtype && vh.indexOf('class="wrapt"') < 0)
        ? ' <span class="at__t" title="dátový typ podľa schémy">' + esc(dtype) + "</span>" : "";
      return '<div class="at' + (changed ? " is-edited" : "") + '" data-ai="' + i + '">' +
               '<div class="at__n"><span class="at__i">' + (i + 1) + "</span>" +
                 (nm ? esc(nm)
                     : '<span class="at__unk">atribút ' + (i + 1) + "</span>") +
                 (changed ? ' <button class="at__undo" data-undo="' + i + '" title="Vrátiť pôvodnú hodnotu">vrátiť</button>' : "") +
               "</div>" +
               '<div class="at__v" data-vi="' + i + '">' +
                 '<span class="at__val">' + vh + typeHTML + "</span>" +
                 (can ? ' <button class="at__edit" data-edit="' + i + '" title="' + esc(tip) + '">✎</button>' : "") +
               "</div>" +
             "</div>";
    }).join("");

    var html =
      '<div class="dt">' +
        '<div class="dt__head">' +
          (id >= 0 ? '<span class="dt__id">#' + id + "</span>" : "") +
          docLink(type, "dt__type kc-" + cat) +
          (st.hist.length ? '<button class="dt__back" id="dtBack" title="Späť na predchádzajúcu entitu">späť</button>' : "") +
        "</div>" +
        '<div class="dt__meta"><span class="dt__cat kc-' + cat + '">' + esc(C.categoryLabel(cat)) + "</span>" +
          (id >= 0 ? '<button class="linkbtn" id="dtGoto">zobraziť v kóde</button>' : "") +
          docNote(type) +
          '<span class="dt__hint" id="dtHint"></span>' +
        "</div>" +
        (args.length ? '<div class="dt__sec">Atribúty <span>' + args.length + "</span>" + anNote + "</div>" +
                       '<div class="dt__attrs">' + rows + "</div>"
                     : '<div class="dt__sec">Atribúty</div><div class="dt__none">bez argumentov</div>') +
        '<div class="dt__sec">Vlastnosti a väzby</div>' +
        '<div id="dtRefs"><button class="btn btn--ghost btn--sm" id="dtScan">Nájsť property sety a odkazy</button></div>' +
      "</div>";
    side.innerHTML = html;
    side.scrollTop = 0;

    var back = $("dtBack");
    if (back) back.addEventListener("click", function () {
      var prev = st.hist.pop();
      if (prev != null) selectStmt(prev, false, true);
    });
    var goto = $("dtGoto");
    if (goto) goto.addEventListener("click", function () {
      var r = rowOfLine(idx.stmtFrom[sIdx]);
      if (r >= 0) { scrollToRow(r, true); $("dtHint").textContent = ""; }
      else $("dtHint").textContent = "entitu skrýva filter tried";
    });
    var scan = $("dtScan");
    if (scan) scan.addEventListener("click", function () { scanRelations(sIdx); });
    if (id >= 0 && idx.lineCount < 120000) scanRelations(sIdx);   // pri menších súboroch rovno
  }

  // =========================================================================
  //  Úprava hodnôt atribútov
  //  Editovateľné sú len jednoduché hodnoty; odkazy (#123), odvodené (*),
  //  nezadané ($), zoznamy a vlastné ID entity zostávajú nemenné.
  // =========================================================================
  var EDITABLE = { text: 1, number: 1, enum: 1 };
  var KIND_LABEL = { text: "text", number: "číslo", int: "celé číslo", bool: "áno/nie",
                     logical: "áno/nie/neznáme", enum: "výčtová hodnota", list: "zoznam hodnôt" };

  // Zoznam sa dá upraviť, ak sú všetky jeho položky jednoduché hodnoty očakávaného druhu.
  function listEditable(raw, ki) {
    var items = C.listItems(raw);
    if (!items) return false;
    var want = ki.item.kind === "text" ? "text"
             : (ki.item.kind === "number" || ki.item.kind === "int") ? "number" : "enum";
    return items.every(function (it) { return C.classifyValue(it).kind === want; });
  }

  // GlobalId je totožnosť objektu (na ňu sa viažu iné nástroje aj BCF) — neupravuje sa.
  function isIdentity(info, name) {
    return info.kind === "text" && (name === "GlobalId" || /^[0-9A-Za-z_$]{22}$/.test(info.value));
  }
  // Dátový typ atribútu podľa schémy (potrebný pre výber z výčtu a pre prázdne hodnoty).
  function kindAt(an, i) {
    var A = window.IFCAttrs;
    return A && an.kinds ? A.kindInfo(an.kinds[i]) : null;
  }
  function canEdit(info, name, ki, raw) {
    if (isIdentity(info, name)) return false;
    if (ki && ki.kind === "list") return info.kind === "unset" || listEditable(raw, ki);
    if (EDITABLE[info.kind]) return true;
    // nezadanú hodnotu vieme doplniť len vtedy, keď zo schémy poznáme jej typ
    return info.kind === "unset" && !!ki && !!KIND_LABEL[ki.kind];
  }

  // Povolené hodnoty pre výber zo zoznamu; null = voľný zápis.
  function enumChoices(ki, info) {
    var A = window.IFCAttrs, vals = null;
    if (ki && ki.kind === "enum" && A) vals = A.enumValues(ki.enumName, st.idx.schema);
    else if (ki && ki.kind === "bool") vals = ["T", "F"];
    else if (ki && ki.kind === "logical") vals = ["T", "F", "U"];
    // hodnota zabalená v dátovom type (typicky NominalValue property setu)
    if (!vals && info.wrap === "IFCBOOLEAN") vals = ["T", "F"];
    if (!vals && info.wrap === "IFCLOGICAL") vals = ["T", "F", "U"];
    if (!vals && info.wrap && A) vals = A.enumValues(info.wrap, st.idx.schema);
    if (!vals || !vals.length) return null;
    vals = vals.slice();
    if (info.kind === "enum" && info.value && vals.indexOf(info.value) < 0) vals.unshift(info.value);
    return vals;
  }

  function beginEdit(sIdx, i) {
    if (sIdx !== st.sel) return;
    var args = C.splitArgs(st.idx.stmtBody(sIdx));
    var info = C.classifyValue(args[i]);
    var an = C.attrNames(st.idx.stmtTypes[sIdx], args, st.idx.schema);
    var ki = kindAt(an, i);
    if (!canEdit(info, an.names[i], ki)) return;

    var cell = $("vwSide").querySelector('.at__v[data-vi="' + i + '"]');
    if (!cell) return;

    if (ki && ki.kind === "list") { editList(sIdx, i, args[i], ki, cell); return; }

    // pri prázdnej hodnote určuje spôsob zápisu schéma
    var wasUnset = info.kind === "unset";
    if (wasUnset) {
      info = ki.kind === "text" ? { kind: "text", value: "", wrap: "" }
           : ki.kind === "number" ? { kind: "number", value: "", real: true, wrap: "" }
           : ki.kind === "int" ? { kind: "number", value: "", int: true, wrap: "" }
           : { kind: "enum", value: "", wrap: "" };
    } else if (ki && info.kind === "number") {
      info.real = ki.kind === "number"; info.int = ki.kind === "int";
    }
    var optional = !ki || ki.optional;
    var choices = info.kind === "enum" ? enumChoices(ki, info) : null;

    if (choices) {
      cell.innerHTML =
        '<div class="ed">' +
          '<select class="ed__sel">' +
            (optional ? '<option value="">(nezadané)</option>' : "") +
            choices.map(function (v) {
              return '<option value="' + esc(v) + '"' + (v === info.value ? " selected" : "") + ">" + esc(v) + "</option>";
            }).join("") +
          "</select>" +
          '<button class="ed__ok" title="Uložiť">✓</button>' +
          '<button class="ed__no" title="Zrušiť (Esc)">✗</button>' +
        "</div>" +
        '<div class="ed__err" hidden></div>';
    } else {
      var hint = KIND_LABEL[ki ? ki.kind : info.kind] || "hodnota";
      cell.innerHTML =
        '<div class="ed">' +
          '<input class="ed__in" type="text" spellcheck="false" placeholder="' + esc(hint) + (optional ? " · prázdne = nezadané" : "") + '">' +
          '<button class="ed__ok" title="Uložiť (Enter)">✓</button>' +
          '<button class="ed__no" title="Zrušiť (Esc)">✗</button>' +
        "</div>" +
        '<div class="ed__err" hidden></div>';
    }

    // popis, ako sa hodnota do súboru zapíše
    var kk = ki ? ki.kind : info.kind;
    var howto = kk === "text" ? "Text sa zapíše v apostrofoch, diakritiku aj apostrofy zakóduje nástroj."
              : kk === "int" ? "Celé číslo, bez desatinnej časti."
              : kk === "number" ? "Desatinná bodka aj čiarka; reálne číslo dostane bodku (3000 → 3000.)."
              : choices ? "Vyberte jednu z hodnôt povolených schémou."
              : "Výčtová hodnota bez bodiek, zapíše sa veľkými písmenami (.HODNOTA.).";
    if (optional) howto += choices ? "" : " Prázdne pole = nezadané ($).";
    cell.insertAdjacentHTML("beforeend", '<div class="ed__how">' + esc(howto) + "</div>" +
                                         '<div class="ed__prev"></div>');

    var field = cell.querySelector(choices ? ".ed__sel" : ".ed__in");
    if (!choices) { field.value = info.value; field.select(); }
    field.focus();

    function fail(msg) {
      var box = cell.querySelector(".ed__err");
      box.hidden = false; box.textContent = msg;
      field.focus();
    }
    function compose() {
      var v = String(field.value);
      if (v.trim() === "") {
        return optional ? { raw: "$" } : { error: "Tento atribút je v schéme povinný, prázdny byť nemôže." };
      }
      return C.serializeValue(info, v);
    }
    function preview() {
      var res = compose(), box = cell.querySelector(".ed__prev"), err = cell.querySelector(".ed__err");
      if (res.error) { box.innerHTML = ""; }
      else { box.innerHTML = "Zapíše sa ako <code>" + esc(res.raw) + "</code>"; err.hidden = true; }
    }
    function save() {
      var res = compose();
      if (res.error) { fail(res.error); return; }
      applyRaw(sIdx, i, res.raw, false, fail);
    }
    preview();
    cell.querySelector(".ed__ok").addEventListener("click", save);
    cell.querySelector(".ed__no").addEventListener("click", function () { renderDetail(sIdx); });
    field.addEventListener(choices ? "change" : "input", choices ? save : preview);
    field.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      else if (e.key === "Escape") { e.preventDefault(); renderDetail(sIdx); }
    });
  }

  /* Editor zoznamu jednoduchých hodnôt (napr. OPTIONAL LIST [1:?] OF IfcLabel).
     Každá položka je na samostatnom riadku; pod poľom je popis zápisu aj živý
     náhľad toho, ako bude hodnota v súbore naozaj vyzerať. */
  function editList(sIdx, i, raw, ki, cell) {
    var itemKind = ki.item.kind;
    var itemInfo = itemKind === "text" ? { kind: "text", wrap: "" }
                 : itemKind === "int" ? { kind: "number", int: true, wrap: "" }
                 : itemKind === "number" ? { kind: "number", real: true, wrap: "" }
                 : { kind: "enum", wrap: "" };
    var allowed = (itemKind === "enum" && window.IFCAttrs)
      ? window.IFCAttrs.enumValues(ki.item.enumName, st.idx.schema)
      : (itemKind === "bool" ? ["T", "F"] : itemKind === "logical" ? ["T", "F", "U"] : null);

    var items = C.listItems(raw) || [];
    var lines = items.map(function (it) {
      var v = C.classifyValue(it);
      return v.kind === "text" ? v.value : v.value != null ? v.value : it;
    });

    var howto = itemKind === "text"
        ? "Každá hodnota na samostatný riadok. Apostrofy aj diakritiku zapíše nástroj sám."
      : itemKind === "enum"
        ? "Každá hodnota na samostatný riadok, bez bodiek." + (allowed ? " Povolené: " + allowed.join(", ") + "." : "")
      : itemKind === "int"
        ? "Každé celé číslo na samostatný riadok."
        : "Každé číslo na samostatný riadok (desatinná bodka aj čiarka).";
    var rules = (ki.min > 0 ? "Zoznam musí mať aspoň " + ki.min + (ki.min === 1 ? " položku. " : " položky. ") : "") +
                (ki.optional ? "Prázdny zoznam = nezadané ($)." : "");

    cell.innerHTML =
      '<div class="ed ed--list">' +
        '<textarea class="ed__area" rows="' + Math.min(8, Math.max(3, lines.length + 1)) + '" spellcheck="false"></textarea>' +
        '<div class="ed__btns">' +
          '<button class="ed__ok" title="Uložiť (Ctrl+Enter)">✓</button>' +
          '<button class="ed__no" title="Zrušiť (Esc)">✗</button>' +
        "</div>" +
      "</div>" +
      '<div class="ed__how">' + esc(howto) + (rules ? " " + esc(rules) : "") + "</div>" +
      '<div class="ed__prev"></div>' +
      '<div class="ed__err" hidden></div>';

    var area = cell.querySelector(".ed__area");
    area.value = lines.join("\n");
    area.focus();

    function values() {
      return area.value.split("\n").map(function (x) { return x.trim(); })
                 .filter(function (x) { return x !== ""; });
    }
    function compose() {
      var vals = values();
      if (!vals.length) {
        if (ki.optional) return { raw: "$" };
        return { error: "Tento zoznam je v schéme povinný — zadajte aspoň " + Math.max(1, ki.min) + " hodnotu." };
      }
      if (vals.length < ki.min) return { error: "Zoznam musí mať aspoň " + ki.min + " položiek, zadané sú " + vals.length + "." };
      if (allowed) {
        for (var n = 0; n < vals.length; n++) {
          if (allowed.indexOf(vals[n].toUpperCase()) < 0)
            return { error: "Riadok " + (n + 1) + ": „" + vals[n] + "“ nie je povolená hodnota. Povolené: " + allowed.join(", ") + "." };
        }
      }
      return C.serializeList(itemInfo, vals);
    }
    function preview() {
      var res = compose();
      var box = cell.querySelector(".ed__prev"), err = cell.querySelector(".ed__err");
      if (res.error) { box.innerHTML = ""; err.hidden = false; err.textContent = res.error; }
      else { box.innerHTML = "Zapíše sa ako <code>" + esc(res.raw) + "</code>"; err.hidden = true; }
    }
    function save() {
      var res = compose();
      if (res.error) { preview(); area.focus(); return; }
      applyRaw(sIdx, i, res.raw, false, function (m) {
        var err = cell.querySelector(".ed__err"); err.hidden = false; err.textContent = m;
      });
    }
    preview();
    area.addEventListener("input", preview);
    area.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      else if (e.key === "Escape") { e.preventDefault(); renderDetail(sIdx); }
    });
    cell.querySelector(".ed__ok").addEventListener("click", save);
    cell.querySelector(".ed__no").addEventListener("click", function () { renderDetail(sIdx); });
  }

  // Zapíše nový zápis argumentu do riadkov súboru.
  function applyRaw(sIdx, i, raw, isUndo, fail) {
    var idx = st.idx, from = idx.stmtFrom[sIdx], to = idx.stmtTo[sIdx];
    var key = sIdx + ":" + i;
    var orig = st.origArgs.has(key) ? st.origArgs.get(key) : C.splitArgs(idx.stmtBody(sIdx))[i];
    var newText;
    try { newText = C.replaceArg(idx.stmtText(sIdx), i, raw); }
    catch (e) { if (fail) fail("Zápis sa nepodarilo upraviť: " + e.message); return; }

    idx.lines[from] = newText + ";";
    for (var j = from + 1; j <= to; j++) idx.lines[j] = "";

    if (isUndo || raw.trim() === String(orig).trim()) {
      st.origArgs.delete(key);
      if (!hasEdits(sIdx)) st.editedStmts.delete(sIdx);
    } else {
      if (!st.origArgs.has(key)) st.origArgs.set(key, orig);
      st.editedStmts.add(sIdx);
    }

    if (newText.length + 1 > idx.maxLen) { idx.maxLen = newText.length + 1; layout(); }
    updateSave();
    if (st.onlyEdited) applyFilter();          // prepočíta, ktoré riadky sú viditeľné
    else {
      render(true);
      if ($("vwQ").value.trim()) runSearch();
    }
    renderDetail(sIdx);
  }
  function hasEdits(sIdx) {
    var pref = sIdx + ":", found = false;
    st.origArgs.forEach(function (v, k) { if (k.indexOf(pref) === 0) found = true; });
    return found;
  }
  function undoEdit(sIdx, i) {
    var key = sIdx + ":" + i;
    if (!st.origArgs.has(key)) return;
    applyRaw(sIdx, i, st.origArgs.get(key), true);
  }

  function updateSave() {
    var n = st.origArgs.size, btn = $("vwSave");
    btn.hidden = n === 0;
    btn.textContent = "Stiahnuť upravený súbor";
    btn.title = n + (n === 1 ? " zmenená hodnota" : n < 5 ? " zmenené hodnoty" : " zmenených hodnôt");

    // prepínač „Upravené“ v hornej lište
    var e = st.editedStmts.size, eb = $("vwEdited");
    eb.disabled = e === 0;
    eb.title = e ? "Zobraziť len upravené entity (" + e + ")" : "Zatiaľ ste nič neupravili";
    $("vwEditedN").textContent = e ? "· " + e : "";
    if (st.onlyEdited && !e) { st.onlyEdited = false; applyFilter(); }   // po vrátení všetkých zmien
    eb.classList.toggle("is-on", st.onlyEdited);
  }
  function downloadEdited() {
    if (!st.idx) return;
    var blob = new Blob([st.idx.lines.join("\n")], { type: "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = st.name.replace(/\.[^.]+$/, "") + "_upraveny.ifc";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function scanRelations(sIdx) {
    var idx = st.idx, id = idx.stmtIds[sIdx], box = $("dtRefs");
    if (!box) return;
    if (id < 0) { box.innerHTML = '<div class="dt__none">nejde o entitu s vlastným #ID</div>'; return; }
    box.innerHTML = '<div class="dt__none">hľadám…</div>';
    setTimeout(function () {
      if (st.sel !== sIdx) return;
      var refs = findReferrers(id, sIdx, 400);
      var psets = psetsFor(sIdx, refs);

      // v property sete sa dá prekliknúť na entitu (do kódu) aj na dokumentáciu triedy
      var ph = psets.map(function (p) {
        var items = p.props.map(function (pr) {
          return '<div class="pr">' +
                   '<span class="pr__n">' +
                     '<button class="pr__go" data-goid="' + pr.id + '" title="Zobraziť entitu #' + pr.id + " · " + esc(pr.type) + '">' +
                       esc(pr.name || "(bez názvu)") + "</button>" +
                     docLink(pr.type, "pr__t", "↗") +
                   "</span>" +
                   '<span class="pr__v">' + valHTML(pr.value, 1, true) + "</span>" +
                 "</div>";
        }).join("");
        return '<div class="pset"><div class="pset__h">' +
                 '<button class="pset__go" data-goid="' + p.id + '" title="Zobraziť entitu #' + p.id + " · " + esc(p.type) + '">' +
                   esc(p.name || "(bez názvu)") + "</button>" +
                 '<span class="pset__id">#' + p.id + "</span>" +
                 docLink(p.type, "pset__t", p.type.replace(/^IFC/, "")) +
               "</div>" +
               (items || '<div class="dt__none">bez vlastností</div>') + "</div>";
      }).join("");

      var others = refs.filter(function (r) { return idx.stmtTypes[r] !== "IFCRELDEFINESBYPROPERTIES" || !psets.length; });
      var oh = others.slice(0, 60).map(function (r) { return refChip(idx.stmtIds[r]); }).join("");

      box.innerHTML =
        (psets.length ? '<div class="dt__sub">Property sety a veličiny</div>' + ph : "") +
        '<div class="dt__sub">Odkazujú sa na ňu <span>' + others.length + (refs.length >= 400 ? "+" : "") + "</span></div>" +
        (others.length ? '<div class="vlist">' + oh + (others.length > 60 ? '<span class="more">+ ' + (others.length - 60) + " ďalších</span>" : "") + "</div>"
                       : '<div class="dt__none">žiadna ďalšia entita sa na ňu neodkazuje</div>');
    }, 10);
  }

  // =========================================================================
  //  Hľadanie
  // =========================================================================
  function runSearch() {
    if (!st.idx) return;
    var q = $("vwQ").value.trim();
    st.hits = []; st.hitPos = -1; st.hitLines = null;
    if (!q) { $("vwHits").textContent = ""; render(true); return; }

    var direct = /^#(\d+)$/.exec(q);
    if (direct && st.idx.byId.has(+direct[1])) {
      selectId(+direct[1], true);
      $("vwHits").textContent = "entita #" + direct[1];
      return;
    }

    var idx = st.idx, needle = q.toLowerCase(), rows = visCount();
    var lines = new Set();
    for (var r = 0; r < rows && st.hits.length < HIT_LIMIT; r++) {
      var li = lineOfRow(r);
      if (idx.lines[li].toLowerCase().indexOf(needle) >= 0) { st.hits.push(r); lines.add(li); }
    }
    st.hitLines = lines;
    if (st.hits.length) { st.hitPos = 0; scrollToRow(st.hits[0], true); }
    else render(true);
    updateHits();
  }
  function updateHits() {
    var n = st.hits.length;
    $("vwHits").textContent = n
      ? (st.hitPos + 1) + " / " + n.toLocaleString("sk-SK") + (n >= HIT_LIMIT ? "+" : "")
      : "žiadna zhoda";
  }
  function gotoHit(d) {
    if (!st.hits.length) return;
    st.hitPos = (st.hitPos + d + st.hits.length) % st.hits.length;
    scrollToRow(st.hits[st.hitPos], true);
    updateHits();
  }

  // =========================================================================
  //  Filter tried
  // =========================================================================
  // Zoznam tried sa prekresľuje podľa toho, čo používateľ píše — najprv triedy
  // začínajúce hľadaným textom, potom tie, ktoré ho obsahujú; v rámci skupiny
  // zostáva poradie podľa počtu výskytov. Zhoda sa v názve zvýrazní.
  function renderTypeList(q) {
    st.typeQuery = (q || "").trim().toLowerCase();
    var needle = st.typeQuery, ranked = [];

    st.idx.types.forEach(function (t) {
      var full = t.type.toLowerCase(), short = full.replace(/^ifc/, ""), rank = 3;
      if (needle) {
        if (short.indexOf(needle) === 0) rank = 0;
        else if (full.indexOf(needle) === 0) rank = 1;
        else if (full.indexOf(needle) > 0) rank = 2;
        else return;
      }
      ranked.push({ t: t, rank: rank });
    });
    ranked.sort(function (a, b) { return a.rank - b.rank; });   // stabilné → počty ostávajú zoradené
    st.typeShown = ranked.map(function (r) { return r.t.type; });

    $("vwTypeList").innerHTML = ranked.length
      ? ranked.map(function (r, i) {
          var type = r.t.type, name = type.replace(/^IFC/, "");
          var on = st.filter && st.filter.has(type);
          return '<label class="tf kc-' + catOf(type) + (i === 0 && needle ? " is-first" : "") + '">' +
                   '<input type="checkbox" class="tf-cb" data-type="' + esc(type) + '"' + (on ? " checked" : "") + ">" +
                   '<span class="tf__n">' + markMatch(name, needle) + "</span>" +
                   '<span class="tf__c">' + r.t.count.toLocaleString("sk-SK") + "</span>" +
                 "</label>";
        }).join("")
      : '<div class="pop__empty">Žiadna trieda nezodpovedá textu „' + esc(q) + "“.</div>";

    renderTypeCount();
  }

  // Zvýrazní nájdenú časť názvu (hľadá sa aj s predponou IFC, ktorá sa nezobrazuje).
  function markMatch(name, needle) {
    if (!needle) return esc(name);
    var pos = name.toLowerCase().indexOf(needle.replace(/^ifc/, ""));
    if (pos < 0 || !needle.replace(/^ifc/, "")) return esc(name);
    var len = needle.replace(/^ifc/, "").length;
    return esc(name.slice(0, pos)) + "<mark>" + esc(name.slice(pos, pos + len)) + "</mark>" + esc(name.slice(pos + len));
  }

  function renderTypeCount() {
    var total = st.idx.types.length, shown = st.typeShown ? st.typeShown.length : total;
    var sel = st.filter ? st.filter.size : 0;
    $("vwTypeCount").innerHTML =
      (st.typeQuery ? shown.toLocaleString("sk-SK") + " z " + total.toLocaleString("sk-SK") : total.toLocaleString("sk-SK")) +
      " tried" + (sel ? ' · <b>vybraných ' + sel + "</b>" : "");
  }

  // Zapne/vypne triedu vo filtri. rerender=true prekreslí aj zoznam
  // (potrebné, keď zmena neprišla priamo z políčka v zozname).
  function toggleType(type, on, rerender) {
    if (!st.filter) st.filter = new Set();
    on ? st.filter.add(type) : st.filter.delete(type);
    if (!st.filter.size) st.filter = null;
    if (rerender) {
      var keep = $("vwTypeList").scrollTop;
      renderTypeList(st.typeQuery);
      $("vwTypeList").scrollTop = keep;
    }
    applyFilter();
  }

  function updateFilterLabel() {
    var n = st.filter ? st.filter.size : 0;
    $("vwFilterN").textContent = n ? "· " + n : "";
    $("vwFilter").classList.toggle("is-on", !!n);
    $("vwEdited").classList.toggle("is-on", st.onlyEdited);
    var vis = visCount();
    $("vwVisible").textContent = (n || st.onlyEdited)
      ? vis.toLocaleString("sk-SK") + " z " + st.idx.lineCount.toLocaleString("sk-SK") + " riadkov"
      : "";
    renderTypeCount();
  }

  // =========================================================================
  //  Udalosti
  // =========================================================================
  function wire() {
    $("fileV").addEventListener("change", function (e) {
      if (e.target.files[0]) handleFile(e.target.files[0]);
      e.target.value = "";
    });

    var code = $("vwCode");
    code.addEventListener("scroll", function () { render(false); });
    window.addEventListener("resize", function () { if (st.idx) { layout(); render(true); } });

    code.addEventListener("click", function (e) {
      var ref = e.target.closest(".t-ref");
      if (ref) { e.stopPropagation(); selectId(+ref.getAttribute("data-ref"), true); return; }
      var row = e.target.closest(".cl");
      if (!row) return;
      var s = st.idx.lineStmt[+row.getAttribute("data-line")];
      if (s >= 0) selectStmt(s, true, false);
    });

    $("vwSide").addEventListener("click", function (e) {
      var b = e.target.closest("[data-goid]");
      if (b) { selectId(+b.getAttribute("data-goid"), true); return; }
      var ed = e.target.closest("[data-edit]");
      if (ed) { beginEdit(st.sel, +ed.getAttribute("data-edit")); return; }
      var un = e.target.closest("[data-undo]");
      if (un) undoEdit(st.sel, +un.getAttribute("data-undo"));
    });
    $("vwSave").addEventListener("click", downloadEdited);

    var timer = null;
    $("vwQ").addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 260);
    });
    $("vwQ").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); st.hits.length ? gotoHit(e.shiftKey ? -1 : 1) : runSearch(); }
    });
    $("vwPrev").addEventListener("click", function () { gotoHit(-1); });
    $("vwNext").addEventListener("click", function () { gotoHit(1); });

    // políčko v zozname — zoznam sa zámerne neprekresľuje, aby kliknutie
    // neodstránilo prvok spod kurzora (zavrelo by to rozbaľovací panel)
    $("vwTypeList").addEventListener("change", function (e) {
      if (!e.target.classList.contains("tf-cb")) return;
      toggleType(e.target.getAttribute("data-type"), e.target.checked, false);
    });
    $("vwTypeNone").addEventListener("click", function () {
      st.filter = null;
      renderTypeList(st.typeQuery);
      applyFilter();
    });

    // písanie v poli „Nájsť triedu…“ hneď zužuje ponuku
    $("vwTypeQ").addEventListener("input", function () {
      renderTypeList(this.value);
      $("vwTypeList").scrollTop = 0;
    });
    // prepínač „Upravené“ — zobrazí len entity, v ktorých ste niečo zmenili
    $("vwEdited").addEventListener("click", function () {
      if (!st.editedStmts.size) return;
      st.onlyEdited = !st.onlyEdited;
      applyFilter();
    });

    $("vwTypeQ").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {                 // Enter zapne/vypne prvú ponúknutú triedu
        e.preventDefault();
        var first = st.typeShown && st.typeShown[0];
        if (first) toggleType(first, !(st.filter && st.filter.has(first)), true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (this.value) { this.value = ""; renderTypeList(""); }
        else $("vwFilter").open = false;
      }
    });

    // zatvorenie rozbaľovacích panelov kliknutím mimo nich
    document.addEventListener("click", function (e) {
      ["vwFilter", "vwLegend"].forEach(function (id) {
        var d = $(id);
        if (d && d.open && !d.contains(e.target)) d.open = false;
      });
    });
  }

  // Nahratie nového súboru — volá sa z tlačidla v hornej lište (js/nav.js).
  window.ViewerTool = { reset: function () { st.idx = null; renderDrop(); } };

  // ---- štart ---------------------------------------------------------------
  if ($("vwPanel")) { wire(); renderDrop(); }
})();
