/* validate.js — nástroj na kontrolu IFC súboru.
 *
 * Dva druhy validácie, prepína sa medzi nimi hore nad nástrojom:
 *
 * buildingSMART — je súbor správne zapísaný podľa štandardu IFC?
 *   1. rýchla — beží hneď po nahratí priamo tu v JS nad indexom z js/ifc-code.js:
 *      štruktúra súboru, verzia schémy, zápis entít, čísla entít, referencie,
 *      GlobalId a nepoužité entity;
 *   2. hĺbková — spustí sa sama hneď po rýchlej, v js/validate-pyodide.js: ifcopenshell.validate
 *      (typy hodnôt, kardinality, výčty, pravidlá WHERE) a normatívne pravidlá
 *      ifc-gherkin-rules, teda jadro oficiálnej validačnej služby buildingSMART.
 *      Prvé spustenie stiahne ~25 MB a beh trvá dlhšie — kým všetko nedobehne,
 *      ukazuje sa len priebeh jednotlivých krokov, výsledky potom naraz.
 *
 * IDS — obsahuje model informácie, ktoré požaduje zadávateľ? K modelu sa nahrá
 *   súbor IDS (Information Delivery Specification) a v tom istom vlákne ho
 *   vyhodnotí knižnica IfcTester z IfcOpenShellu.
 *
 * Výsledky buildingSMART sú zoradené do štyroch kategórií ako vo validačnej službe
 * validate.buildingsmart.org: zápis STEP, schéma IFC, normatívne pravidlá a
 * odporúčané praktiky. Pri každej kontrole, ktorá neprešla, je návod na opravu
 * z js/validate-fixes.js.
 *
 * Model je pre oba druhy spoločný — po prepnutí sa nemusí nahrávať znova.
 * Súbory nikam neodchádzajú — všetko beží vo vašom prehliadači.
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var C = window.IFCCode;
  var esc = C.esc;

  // Schémy, ktoré prijíma validačná služba buildingSMART.
  var SUPPORTED = { IFC2X3: 1, IFC4: 1, IFC4X3_ADD2: 1 };
  // Príkazy, ktoré podľa ISO 10303-21 nie sú entitami (nemajú #ID).
  var SECTION_KW = {
    "ISO-10303-21": 1, "END-ISO-10303-21": 1, HEADER: 1, DATA: 1, ENDSEC: 1,
    FILE_DESCRIPTION: 1, FILE_NAME: 1, FILE_SCHEMA: 1, FILE_POPULATION: 1,
    SECTION_LANGUAGE: 1, SECTION_CONTEXT: 1, ANCHOR: 1, REFERENCE: 1, SIGNATURE: 1
  };
  var LIST_MAX = 120;        // koľko nálezov sa vypíše (zvyšok len spočíta)
  var COLLECT_MAX = 600;     // koľko sa ich vôbec drží v pamäti
  var BIG_MB = 100;          // nad túto veľkosť sa pri hĺbkovej kontrole varuje
  var MODE_KEY = "mini-ifc.validate.mode";

  var st = {
    mode: loadMode(),                             // bsdd | ids
    file: null, name: "", size: 0,
    analyzing: null,                              // súbor, nad ktorým beží rýchla kontrola
    idx: null, checks: null, stats: null,
    deep: null, deepState: "idle", deepMs: 0,     // kontrola podľa schémy
    rules: null, rulesState: "idle", rulesMs: 0,  // normatívne pravidlá
    rulesInfo: null,                              // súhrn behu pravidiel
    idsFile: null, idsMeta: null,                 // súbor IDS a čo sa z neho dá vyčítať hneď
    ids: null, idsState: "idle", idsMs: 0,        // vyhodnotenie IDS
    // stavy: idle | running | done | error. Všetky tri kontroly zdieľajú jedno
    // vlákno, takže naraz beží vždy len jedna — busy hovorí ktorá.
    busy: null, msg: "", prog: null, err: {}, timer: null, t0: 0,
    queue: [],                                    // kontroly, ktoré sa spustia po tejto
    shown: null,                                  // súbor, ktorého karty výsledkov sú vykreslené
    autoRun: null,                                // súbor, pre ktorý sa už všetky kontroly spustili samy
    pipe: null                                    // súbor, nad ktorým beží celá kontrola (výsledky čakajú)
  };

  // =========================================================================
  //  Vlákno s hĺbkovou kontrolou
  // =========================================================================
  var engine = (function () {
    var worker = null, handler = null;
    function boot() {
      if (worker) return worker;
      worker = new Worker("js/validate-pyodide.js");
      worker.onmessage = function (ev) { if (handler) handler(ev.data); };
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        worker = null;
        if (handler) handler({ type: "error", message:
          "Výpočtové vlákno sa nepodarilo spustiť. Stránku otvorte cez http(s), nie ako súbor z disku." });
      };
      return worker;
    }
    return {
      run: function (msg, transfer, onMsg) {
        handler = onMsg;
        try { boot().postMessage(msg, transfer); }
        catch (e) { onMsg({ type: "error", message: e.message }); }
      },
      stop: function () {
        if (worker) { worker.terminate(); worker = null; }
        handler = null;
      }
    };
  })();

  // =========================================================================
  //  Načítanie súboru
  // =========================================================================
  var UPLOAD_ICON = '<svg class="drop__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4m0 0L7 9m5-5l5 5"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/></svg>';

  function panel() { return $("vlPanel"); }
  function setHead(tag, title, sub) {
    panel().querySelector(".panel__tag").textContent = tag;
    $("vlTitle").textContent = title;
    $("vlSub").textContent = sub || "";
  }

  function renderDrop(errorMsg) {
    $("vlHead").hidden = false;
    panel().hidden = false;
    panel().classList.toggle("is-error", !!errorMsg);
    $("vlApp").hidden = true;
    if (window.AppBar) { AppBar.setStatus("kontrola súboru"); AppBar.setBadge(""); }
    setHead(errorMsg ? "chyba" : "súbor",
            errorMsg ? "súbor sa nepodarilo načítať" : "nahrajte IFC alebo STEP",
            ".ifc · .step · .stp");
    $("vlBody").innerHTML =
      (errorMsg ? '<div class="note note--bad" style="margin-bottom:12px"><span class="note__i">✕</span>' +
                  "<span>" + esc(errorMsg) + "</span></div>" : "") +
      '<div class="drop drop--tall" id="vlDrop">' + UPLOAD_ICON +
        '<div class="drop__main">' + (errorMsg ? "skúsiť iný súbor" : "presuňte sem súbor") + "</div>" +
        '<div class="drop__hint">alebo kliknite pre výber · súbor zostáva vo vašom počítači</div>' +
      "</div>";
    var dz = $("vlDrop");
    dz.addEventListener("click", function () { $("fileC").click(); });
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("is-over"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("is-over"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault(); dz.classList.remove("is-over");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
  }

  // Priebeh celej kontroly. Kým beží ktorýkoľvek krok, výsledky sa neukazujú —
  // vykreslia sa naraz po poslednom kroku (alebo po zrušení či chybe).
  var STAGES = [
    { key: "quick", name: "rýchla kontrola", sub: "štruktúra súboru, zápis entít, odkazy, GlobalId" },
    { key: "validate", name: "hĺbková kontrola schémy", sub: "ifcopenshell.validate — typy, kardinality, výčty, pravidlá WHERE" },
    { key: "rules", name: "pravidlá buildingSMART", sub: "ifc-gherkin-rules — normatívne pravidlá a odporúčané praktiky" }
  ];
  var quickProg = { label: "", pct: null };

  function stageState(key) {
    if (key === "quick") return st.checks ? "done" : "running";
    if (st.busy === key) return "running";
    var s = key === "validate" ? st.deepState : st.rulesState;
    return s === "done" || s === "error" ? s : "wait";
  }

  function stageHTML(sg) {
    var state = stageState(sg.key);
    var lvl = { done: "ok", error: "bad", wait: "skip", running: "run" }[state];
    var note = state === "wait" ? "čaká" : state === "error" ? "chyba" : state === "running" ? "beží" :
               sg.key === "validate" ? "hotovo · " + (st.deepMs / 1000).toFixed(1) + " s" :
               sg.key === "rules" ? "hotovo · " + (st.rulesMs / 1000).toFixed(0) + " s" : "hotovo";
    var body = "";
    if (state === "running") {
      var pct = sg.key === "quick" ? quickProg.pct
              : st.prog && st.prog.total ? st.prog.done / st.prog.total : null;
      body = '<div class="deep__msg">' + esc(sg.key === "quick" ? quickProg.label : st.msg || "pripravujem…") + "</div>" +
             (pct == null ? "" : '<div class="pbar pbar--chk"><i style="width:' + Math.round(pct * 100) + '%"></i></div>') +
             (sg.key === "rules" && st.prog && st.prog.total
               ? '<div class="help">' + st.prog.done + " / " + st.prog.total + " pravidiel</div>" : "") +
             (sg.key === "quick" ? "" : '<div class="help" id="vlElapsed">beží ' +
               Math.round((Date.now() - st.t0) / 1000) + " s</div>");
    } else if (state === "error") {
      body = '<div class="chk__d">' + esc(st.err[sg.key] || "") + "</div>";
    }
    return '<div class="chk is-' + lvl + '">' +
             (lvl === "run" ? '<span class="chk__i"><span class="spinner"></span></span>'
                            : '<span class="chk__i">' + ICON[lvl] + "</span>") +
             '<div class="chk__b">' +
               '<div class="chk__t">' + esc(sg.name) + '<span class="chk__n">' + esc(note) + "</span></div>" +
               '<div class="chk__d">' + esc(sg.sub) + "</div>" +
               body +
             "</div>" +
           "</div>";
  }

  function renderPipeline() {
    $("vlHead").hidden = false;
    panel().hidden = false;
    $("vlApp").hidden = true;
    panel().classList.remove("is-error");
    var done = STAGES.filter(function (sg) { return stageState(sg.key) === "done"; }).length;
    setHead("kontrola", st.name, done + " / " + STAGES.length + " hotovo");
    $("vlBody").innerHTML =
      '<div class="chks">' + STAGES.map(stageHTML).join("") + "</div>" +
      '<div class="pipe__foot">' +
        '<p class="help">Výsledky sa zobrazia naraz, keď dobehnú všetky kontroly. Prvé spustenie ' +
        "stiahne ~25 MB knižníc, väčší model sa môže kontrolovať aj niekoľko minút. Súbor zostáva " +
        "vo vašom počítači.</p>" +
        sizeNote(true) +
        (st.busy ? '<button class="btn btn--sm btn--ghost" id="vlPStop" type="button">zrušiť a ukázať ' +
                   "doterajšie výsledky</button>" : "") +
      "</div>";
    if (st.busy) $("vlPStop").addEventListener("click", stopJob);
  }

  function progress(label, pct) {
    quickProg = { label: label, pct: pct };
    renderPipeline();
  }

  // Nový model — výsledky oboch druhov kontroly sa týkali predošlého.
  function handleFile(file) {
    resetJobs();
    st.file = file; st.name = file.name; st.size = file.size;
    st.idx = null; st.checks = null; st.stats = null; st.analyzing = null;
    render();
  }

  // Rýchla kontrola beží len v režime buildingSMART. Model nahratý pri IDS sa
  // skontroluje až po prepnutí — kontrolu IDS netreba zdržiavať.
  function analyzeFile() {
    var file = st.file;
    st.analyzing = file;
    progress("číta sa súbor…", null);
    // výsledok z iného súboru alebo z druhého režimu sa len uloží
    function current() { return st.file === file; }
    function shown() { return current() && st.mode === "bsdd"; }
    function fail(msg) {
      if (!current()) return;
      st.analyzing = null;
      // súbor, ktorý sa nedá prečítať, nemá zmysel držať ani pre IDS
      st.file = null; st.name = ""; st.size = 0;
      if (st.mode === "bsdd") renderDrop(msg); else render();
    }
    var reader = new FileReader();
    reader.onload = function () {
      if (!current()) return;
      if (shown()) progress("analyzujem štruktúru súboru…", 0);
      var text = reader.result;
      C.indexFile(text, function (p) { if (shown()) progress("analyzujem štruktúru súboru…", p * 0.6); })
        .then(function (idx) {
          if (!current()) throw null;
          st.idx = idx;
          return analyze(idx, text, function (p) {
            if (shown()) progress("kontrolujem zápis a väzby…", 0.6 + p * 0.4);
          });
        })
        .then(function (res) {
          if (!current()) return;
          st.analyzing = null;
          st.checks = res.checks; st.stats = res.stats;
          if (st.mode === "bsdd") render();
        })
        .catch(function (err) { if (err) fail(err.message); });
    };
    reader.onerror = function () { fail("Chyba pri čítaní súboru."); };
    reader.readAsText(file);
  }

  // =========================================================================
  //  Rýchla kontrola (JS)
  // =========================================================================
  function chk(key, title, desc) {
    // fix = čo s nálezom urobiť (js/validate-fixes.js), ukáže sa pri neúspechu
    return { key: key, title: title, desc: desc, level: "ok", note: "", items: [], total: 0,
             fix: window.ValidateFixes ? window.ValidateFixes.check(key) : "" };
  }
  // Nálezy sa zbierajú len po strop — u rozbitého súboru ich môžu byť milióny.
  // id = číslo entity, ktorej sa nález týka (kvôli prekliku do prehliadača kódu).
  function add(c, text, line, full, id) {
    c.total++;
    if (c.items.length < COLLECT_MAX)
      c.items.push({ text: text, line: line == null ? -1 : line, full: full || "",
                     id: entId(id) });
  }
  // Číslo entity z rôznych zdrojov (JS kontrola dáva číslo, knižnice text „#123“).
  function entId(v) {
    if (v == null) return -1;
    var n = typeof v === "number" ? v : parseInt(String(v).replace(/^\s*#/, ""), 10);
    return (isFinite(n) && n >= 0) ? n : -1;
  }
  function seal(c, level, okNote, badNote) {
    if (c.total) { c.level = level; c.note = badNote(c.total); }
    else { c.level = "ok"; c.note = okNote; }
    return c;
  }
  function plural(n, one, few, many) {
    return n === 1 ? one : (n < 5 ? few : many);
  }

  function analyze(idx, text, onProgress) {
    return new Promise(function (resolve) {
      var A = window.IFCAttrs;
      var schema = idx.schema;

      // ---- 1) štruktúra súboru (SPF obálka a hlavička) --------------------
      var cStruct = chk("struct", "Štruktúra súboru",
        "Obálka podľa ISO 10303-21 a povinné záznamy v hlavičke.");
      var headTxt = text.slice(0, 4096);
      var tailTxt = text.slice(-4096);
      if (!/^\s*(﻿)?ISO-10303-21\s*;/i.test(headTxt))
        add(cStruct, "Súbor sa nezačína zápisom ISO-10303-21;", 0);
      if (!/END-ISO-10303-21\s*;/i.test(tailTxt))
        add(cStruct, "Chýba ukončenie END-ISO-10303-21; — súbor môže byť orezaný.");
      var kw = {};
      idx.stmtTypes.forEach(function (t, i) { if (idx.stmtIds[i] < 0 && t) kw[t] = 1; });
      if (!kw.HEADER) add(cStruct, "Chýba sekcia HEADER;");
      if (!kw.DATA) add(cStruct, "Chýba sekcia DATA;");
      ["FILE_DESCRIPTION", "FILE_NAME", "FILE_SCHEMA"].forEach(function (k) {
        if (!kw[k]) add(cStruct, "V hlavičke chýba záznam " + k + "(…);");
      });
      seal(cStruct, "bad", "obálka aj hlavička sú kompletné",
           function (n) { return n + " " + plural(n, "chýbajúca časť", "chýbajúce časti", "chýbajúcich častí"); });

      // ---- 2) verzia schémy ----------------------------------------------
      var cSchema = chk("schema", "Verzia schémy",
        "Validačná služba buildingSMART pracuje so schémami IFC2X3, IFC4 a IFC4X3_ADD2.");
      if (SUPPORTED[schema]) {
        cSchema.level = "ok"; cSchema.note = schema + " — podporovaná";
      } else if (schema && schema !== "neznáma" && /^IFC/.test(schema)) {
        cSchema.level = "warn";
        cSchema.note = schema + " — mimo rozsahu oficiálnej validácie";
        add(cSchema, "Súbor je zapísaný v schéme " + schema + ". Hĺbková kontrola ju " +
                     "nemusí poznať a normatívne pravidlá pre ňu neexistujú.");
      } else {
        cSchema.level = "bad"; cSchema.note = "schéma sa nedá určiť";
        add(cSchema, "Zo záznamu FILE_SCHEMA sa nepodarilo prečítať názov schémy.");
      }

      // ---- 3) jedna prechádzka cez všetky príkazy -------------------------
      var cSyntax = chk("syntax", "Zápis entít",
        "Tvar #ID = TRIEDA(…); , párové zátvorky a ukončenie bodkočiarkou.");
      var cIds = chk("ids", "Čísla entít (#ID)", "Každé číslo entity smie byť v súbore len raz.");
      var cRefs = chk("refs", "Referencie", "Každý odkaz #ID musí ukazovať na entitu, ktorá v súbore existuje.");
      var cGuid = chk("guid", "GlobalId", "22-znakový identifikátor objektov — jedinečný a v správnom tvare.");
      var cTypes = chk("types", "Triedy a atribúty", "Trieda musí byť v schéme a mať očakávaný počet atribútov.");
      var cOrph = chk("orph", "Nepoužité entity", "Entity, na ktoré sa nikto neodkazuje a nie sú samostatnými objektmi.");

      var n = idx.stmtIds.length, i = 0;
      var maxId = 0;
      for (var k = 0; k < n; k++) if (idx.stmtIds[k] > maxId) maxId = idx.stmtIds[k];
      var seenId = new Uint8Array(maxId + 2);      // #ID sa už vyskytlo
      var refd = new Uint8Array(maxId + 2);        // na #ID sa niekto odkazuje
      var rooted = new Uint8Array(maxId + 2);      // entita má GlobalId (samostatný objekt)
      var defined = new Uint8Array(maxId + 2);     // #ID je v súbore zapísané
      var guids = new Map();                       // GlobalId → riadok prvého výskytu
      var badTypes = new Set();                    // triedy, pri ktorých niečo nesedí (len na súhrn)
      var wantArgs = new Map();                    // trieda → počet atribútov podľa schémy súboru
      var missRefs = new Map();                    // chýbajúce #ID → riadok prvého odkazu

      // Odkazy na iné entity. „Podozrivé" sa odložia a overia až na konci —
      // entita, na ktorú ukazujú, môže byť zapísaná nižšie v súbore.
      function scanRefs(masked, line) {
        var re = /#(\d+)/g, m;
        while ((m = re.exec(masked))) {
          var r = +m[1];
          if (r <= maxId) refd[r] = 1;
          if (!idx.byId.has(r) && !missRefs.has(r)) missRefs.set(r, line);
        }
      }

      function step() {
        var t0 = Date.now();
        while (i < n) {
          var line = idx.stmtFrom[i];
          var full = idx.stmtText(i);
          // Poznámka /* … */ pred príkazom nie je chyba, len ju treba odstrániť.
          // Viacriadková poznámka sa začína ešte v predošlom príkaze, takže tento
          // môže začínať jej koncom — odrežeme aj ten.
          var closeC = full.indexOf("*/"), openC = full.indexOf("/*");
          if (closeC >= 0 && (openC < 0 || closeC < openC)) full = full.slice(closeC + 2);
          full = full.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, "").trim();
          if (!full) { i++; continue; }

          var head = /^#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/.exec(full);
          if (!head) {
            // buď je to kľúčové slovo súboru, alebo pokazený zápis entity
            var kw = /^([A-Za-z0-9_\-]+)/.exec(full);
            if (full.charAt(0) === "#" || !kw || !SECTION_KW[kw[1].toUpperCase()]) {
              add(cSyntax, (full.length > 60 ? full.slice(0, 60) + "…" : full) +
                           " — zápis nemá tvar #ID = TRIEDA(…)", line);
            } else {
              // hlavička súboru sa kontroluje inde, odkazy v nej nie sú
              scanRefs(C.maskStrings(full), line);
            }
            i++; continue;
          }

          var id = +head[1];
          var type = head[2].toUpperCase();
          if (id <= maxId) {
            if (seenId[id]) add(cIds, "Číslo #" + id + " je použité viackrát.", line, "", id);
            else seenId[id] = 1;
            defined[id] = 1;
          }

          var body = full.slice(full.indexOf("=") + 1);
          var masked = C.maskStrings(body);

          // zátvorky a to, čo je za nimi
          var open = masked.indexOf("("), depth = 0, end = -1;
          for (var c = open; c < masked.length; c++) {
            if (masked[c] === "(") depth++;
            else if (masked[c] === ")") { depth--; if (!depth) { end = c; break; } }
          }
          if (end < 0) {
            add(cSyntax, "#" + id + " " + type + " — zátvorky nie sú párové", line, "", id);
            i++; continue;
          }
          if (masked.slice(end + 1).trim()) {
            add(cSyntax, "#" + id + " " + type + " — za uzatváracou zátvorkou je ďalší text", line, "", id);
          }
          var args = C.splitTopLevel(body.slice(open + 1, end), masked.slice(open + 1, end));

          scanRefs(masked, line);

          // trieda a počet atribútov podľa registra schémy
          // Nález sa zapisuje pre každú entitu zvlášť — aj keď je chyba pri celej
          // triede, používateľ potrebuje vedieť konkrétne #ID, na ktoré sa preklikne.
          var info = A ? A.attrsFor(type, schema, args.length) : null;
          if (!info) {
            badTypes.add(type);
            add(cTypes, "#" + id + " " + type + " — trieda nie je v registri schémy", line, "", id);
          } else {
            if (info.names.length !== args.length) {
              // koľko atribútov čaká práve schéma súboru (info mohlo sadnúť na inú
              // verziu); pre triedu je to vždy rovnaké, tak sa to počíta raz
              var want = wantArgs.get(type);
              if (want == null) {
                var ref = A.attrsFor(type, schema, 0);
                want = (ref || info).names.length;
                if (ref) wantArgs.set(type, want);
              }
              badTypes.add(type);
              add(cTypes, "#" + id + " " + type + " — " + args.length + " " +
                          plural(args.length, "atribút", "atribúty", "atribútov") +
                          ", schéma očakáva " + want, line, "", id);
            }
            if (info.names[0] === "GlobalId") {
              if (id <= maxId) rooted[id] = 1;
              var g = args.length ? args[0].trim() : "";
              if (g.charAt(0) !== "'" || g.charAt(g.length - 1) !== "'") {
                add(cGuid, "#" + id + " " + type + " — GlobalId nie je textová hodnota", line, "", id);
              } else {
                var v = g.slice(1, -1);
                if (!/^[0-9A-Za-z_$]{22}$/.test(v)) {
                  add(cGuid, "#" + id + " " + type + " — GlobalId '" + v + "' nemá tvar 22 znakov", line, "", id);
                } else if (guids.has(v)) {
                  add(cGuid, "#" + id + " " + type + " — GlobalId '" + v +
                             "' už má entita na riadku " + (guids.get(v) + 1), line, "", id);
                } else guids.set(v, line);
              }
            }
          }

          i++;
          if ((i & 255) === 0 && Date.now() - t0 > 24) break;
        }
        if (i < n) { if (onProgress) onProgress(i / n); setTimeout(step, 0); return; }
        finish();
      }

      function finish() {
        // visiace referencie — až teraz, keď sú známe všetky zapísané čísla
        // preklik vedie na entitu, ktorá sa odkazuje — cieľ odkazu neexistuje
        missRefs.forEach(function (line, r) {
          if (r <= maxId && defined[r]) return;
          add(cRefs, "Odkaz #" + r + " nesmeruje na žiadnu entitu v súbore.", line);
        });

        // nepoužité entity — nikto sa na ne neodkazuje a nie sú samostatnými objektmi
        for (var s = 0; s < n; s++) {
          var id = idx.stmtIds[s];
          if (id < 0 || id > maxId || !defined[id]) continue;
          if (refd[id] || rooted[id]) continue;
          add(cOrph, "#" + id + " " + idx.stmtTypes[s] + " — na entitu sa nikto neodkazuje",
              idx.stmtFrom[s], "", id);
        }

        seal(cSyntax, "bad", "všetky entity majú platný zápis",
             function (c) { return c + " " + plural(c, "chybný zápis", "chybné zápisy", "chybných zápisov"); });
        seal(cIds, "bad", "čísla entít sú jedinečné",
             function (c) { return c + " " + plural(c, "duplicita", "duplicity", "duplicít"); });
        seal(cRefs, "bad", "všetky odkazy smerujú na existujúce entity",
             function (c) { return c + " " + plural(c, "visiaci odkaz", "visiace odkazy", "visiacich odkazov"); });
        seal(cGuid, "bad", guids.size.toLocaleString("sk-SK") + " " +
             plural(guids.size, "objekt", "objekty", "objektov") + " s jedinečným GlobalId",
             function (c) { return c + " " + plural(c, "problém", "problémy", "problémov"); });
        // nálezov je toľko, koľko entít — v súhrne sa hodí aj počet dotknutých tried
        seal(cTypes, "warn", "všetky triedy pozná register schémy",
             function (c) {
               var t = badTypes.size;
               return c.toLocaleString("sk-SK") + " " + plural(c, "entita", "entity", "entít") +
                      " · " + t + " " + plural(t, "trieda", "triedy", "tried") + " mimo očakávania";
             });
        seal(cOrph, "info", "žiadne entity navyše",
             function (c) { return c.toLocaleString("sk-SK") + " " + plural(c, "entita", "entity", "entít"); });

        // posledný príkaz bez bodkočiarky sa do indexu vôbec nedostane
        var lastSemi = text.lastIndexOf(";");
        if (lastSemi >= 0 && text.slice(lastSemi + 1).trim()) {
          add(cSyntax, "Za posledným príkazom je text, ktorý nie je ukončený bodkočiarkou.");
          cSyntax.level = "bad";
          cSyntax.note = cSyntax.total + " " + plural(cSyntax.total, "chybný zápis", "chybné zápisy", "chybných zápisov");
        }

        resolve({
          checks: [cStruct, cSchema, cSyntax, cIds, cRefs, cGuid, cTypes, cOrph],
          stats: {
            entities: idx.entityCount,
            objects: guids.size,
            types: idx.types.length,
            lines: idx.lineCount
          }
        });
      }

      setTimeout(step, 0);
    });
  }

  // =========================================================================
  //  Výsledok — štyri kategórie validačnej služby buildingSMART
  // =========================================================================
  var ICON = { ok: "✓", warn: "!", bad: "✕", info: "·", skip: "–" };

  // Rovnaké stĺpce ako vo výsledkoch validate.buildingsmart.org. quick = kontroly
  // z rýchlej kontroly, ktoré do kategórie patria; zvyšok doplnia kontroly vo
  // vlákne (schéma → ifcopenshell.validate, pravidlá → ifc-gherkin-rules).
  var CATS = [
    { key: "syntax", name: "zápis STEP", en: "STEP Syntax", quick: ["struct", "syntax", "ids", "refs"],
      desc: "Dá sa súbor vôbec prečítať? Obálka a hlavička podľa ISO 10303-21, zápis entít, " +
            "jedinečné čísla #ID a odkazy, ktoré smerujú na existujúce entity." },
    { key: "schema", name: "schéma IFC", en: "IFC Schema", quick: ["schema", "types", "guid"],
      desc: "Zodpovedá obsah schéme EXPRESS deklarovanej verzie IFC? Triedy, počty a typy atribútov, " +
            "výčty, kardinality, jedinečné GlobalId a pravidlá WHERE." },
    { key: "norm", name: "normatívne pravidlá IFC", en: "Normative IFC Rules", quick: [],
      desc: "Záväzné predpisy buildingSMART nad rámec schémy — Implementer Agreements a Informal " +
            "Propositions: priestorová štruktúra, väzby, umiestnenie, reprezentácie, georeferencovanie…" },
    { key: "pract", name: "odporúčané praktiky", en: "Industry Practices", quick: ["orph"],
      desc: "Odporúčania, ktorých porušenie súbor nerobí neplatným, ale ide proti bežnej praxi — " +
            "výsledkom sú výhrady, nie chyby." }
  ];

  function worst(checks) {
    var bad = false, warn = false;
    checks.forEach(function (c) {
      if (c.level === "bad") bad = true;
      else if (c.level === "warn") warn = true;
    });
    return bad ? "bad" : warn ? "warn" : "ok";
  }

  function fmt(n) { return n.toLocaleString("sk-SK"); }

  function quickOf(cat) {
    return st.checks.filter(function (c) { return cat.quick.indexOf(c.key) >= 0; });
  }

  // Stav kategórie: nálezy zo všetkých kontrol, ktoré do nej patria, a či už
  // dobehlo všetko (schéma bez hĺbkovej kontroly je posúdená len čiastočne).
  function catState(cat) {
    var job = [], done = true;
    if (cat.key === "schema") { job = st.deep || []; done = st.deepState === "done"; }
    else if (cat.key !== "syntax") { job = st.rules ? st.rules[cat.key] : []; done = !!st.rules; }
    var checks = quickOf(cat).concat(job);
    var level = worst(checks);
    // pravidlá bez spustenia sa posúdiť nedajú — rýchla kontrola tam dáva len informácie
    if (!done && cat.key !== "schema" && level === "ok") level = "skip";
    return { checks: checks, level: level, done: done };
  }

  function catNote(cat, s) {
    if (s.level === "skip") return "nespustené";
    var bad = 0, warn = 0, rules = 0;
    s.checks.forEach(function (c) {
      if (c.level === "bad") bad += c.total;
      else if (c.level === "warn") warn += c.total;
      if (c.rule && c.total) rules++;
    });
    var parts = [];
    if (rules) parts.push(rules + " " + plural(rules, "pravidlo neprešlo", "pravidlá neprešli", "pravidiel neprešlo"));
    else if (bad) parts.push(fmt(bad) + " " + plural(bad, "chyba", "chyby", "chýb"));
    else if (warn) parts.push(fmt(warn) + " " + plural(warn, "výhrada", "výhrady", "výhrad"));
    else parts.push("bez chýb");
    if (!s.done) parts.push("len rýchla kontrola");
    return parts.join(" · ");
  }

  function levelBadge(s) {
    if (s.level === "skip") return '<span class="badge badge--skip">nespustené</span>';
    return (s.level === "bad" ? '<span class="badge badge--bad">nájdené chyby</span>'
          : s.level === "warn" ? '<span class="badge badge--warn">s výhradami</span>'
          : '<span class="badge badge--ok">bez chýb</span>') +
           (s.done ? "" : '<span class="badge badge--skip">čiastočne</span>');
  }

  function itemsHTML(c) {
    if (!c.total) return "";
    var shown = c.items.slice(0, LIST_MAX);
    var links = 0;
    var rows = shown.map(function (it) {
      // nález, ku ktorému poznáme entitu alebo riadok, sa dá otvoriť
      // v prehliadači kódu — celý riadok zoznamu je vtedy kliknuteľný
      var go = it.id >= 0 || it.line >= 0;
      if (go) links++;
      var where = it.id >= 0 ? "entitu #" + it.id : "riadok " + (it.line + 1);
      // celé hlásenie z knižnice býva na desiatky riadkov — v zozname je skrátené,
      // úplné znenie ukáže prehliadač v bublinovej nápovede
      var tip = it.full ? it.full + "\n\n" : "";
      if (go) tip += "Kliknutím otvoríte " + where + " v prehliadači kódu.";
      return "<li" + (go ? ' class="is-link" data-goid="' + it.id + '" data-goline="' + it.line + '"' : "") +
             (tip ? ' title="' + esc(tip) + '"' : "") + ">" +
             (it.line >= 0 ? '<span class="fnd__l">riadok ' + (it.line + 1) + "</span>" : "") +
             "<span>" + esc(it.text) + "</span>" +
             (go ? '<button class="fnd__go" type="button" title="Otvoriť ' + esc(where) +
                   ' v prehliadači kódu">kód ↗</button>' : "") +
             "</li>";
    }).join("");
    var rest = c.total - shown.length;
    return '<details class="chk__more"><summary>zobraziť nálezy (' +
             c.total.toLocaleString("sk-SK") + ")" +
             (links ? '<span class="fnd__tip">nález otvoríte kliknutím v prehliadači kódu</span>' : "") +
             "</summary>" +
             '<ul class="fnd">' + rows + "</ul>" +
             (rest > 0 ? '<div class="fnd__rest">…a ďalších ' + rest.toLocaleString("sk-SK") +
                         " — vypisuje sa prvých " + LIST_MAX + "</div>" : "") +
           "</details>";
  }

  // Návod na opravu sa ukáže len pri kontrole, ktorá neprešla.
  function fixHTML(c) {
    if (!c.fix || c.level === "ok") return "";
    return '<div class="chk__fix"><span class="chk__fk">' + esc(c.fixLabel || "ako opraviť") + "</span>" +
             "<span>" + esc(c.fix) +
               (c.link ? ' <a href="' + esc(c.link) + '" target="_blank" rel="noopener">popis pravidla ↗</a>' : "") +
             "</span>" +
           "</div>";
  }

  function checkHTML(c) {
    return '<div class="chk is-' + c.level + '">' +
             '<span class="chk__i">' + ICON[c.level] + "</span>" +
             '<div class="chk__b">' +
               '<div class="chk__t">' + esc(c.title) +
                 (c.note ? '<span class="chk__n">' + esc(c.note) + "</span>" : "") + "</div>" +
               (c.desc ? '<div class="chk__d">' + esc(c.desc) + "</div>" : "") +
               fixHTML(c) +
               itemsHTML(c) +
             "</div>" +
           "</div>";
  }

  function statHTML(k, v, vs) {
    return '<div class="stat"><div class="k">' + esc(k) + "</div>" +
           (vs ? '<div class="vs">' + esc(vs) + "</div>" : '<div class="v">' + esc(v) + "</div>") + "</div>";
  }

  // Kostra štyroch kariet — rýchla kontrola sa vypíše hneď, časti z vlákna
  // (vlJob-…) a hlavičky sa prekresľujú podľa behu, aby sa nezatvárali
  // rozbalené nálezy rýchlej kontroly.
  function showResults() {
    var idx = st.idx, s = st.stats;
    $("vlHead").hidden = true;
    panel().hidden = true;
    $("vlApp").hidden = false;
    if (window.AppBar) { AppBar.setStatus(st.name); AppBar.setBadge(""); }

    $("vlChips").innerHTML =
      '<div class="m">schéma <b>' + esc(idx.schema) + "</b></div>" +
      (idx.lengthUnit !== "?" ? '<div class="m">jednotka <b>' + esc(idx.lengthUnit) + "</b></div>"
                              : '<div class="m is-warn">jednotka neurčená</div>') +
      '<div class="m">entity <b>' + s.entities.toLocaleString("sk-SK") + "</b></div>" +
      '<div class="m">triedy <b>' + s.types + "</b></div>" +
      '<div class="m">' + Math.round(st.size / 1024).toLocaleString("sk-SK") + " kB</div>";

    CATS.forEach(function (cat) {
      var quick = quickOf(cat), job = cat.key !== "syntax";
      $("vlCat-" + cat.key).innerHTML =
        '<div class="result__head" id="vlCH-' + cat.key + '"></div>' +
        '<div class="result__body">' +
          '<p class="help vlcat__d">' + esc(cat.desc) + "</p>" +
          (quick.length ? (job ? '<div class="vlsub">rýchla kontrola · hneď po nahratí</div>' : "") +
                          '<div class="chks">' + quick.map(checkHTML).join("") + "</div>" : "") +
          (job ? '<div class="vljob" id="vlJob-' + cat.key + '"></div>' : "") +
        "</div>";
    });
    st.shown = st.file;
    renderBsdd();
  }

  function renderBsdd() {
    if (!st.checks || st.shown !== st.file) return;
    renderSummary();
    CATS.forEach(renderCatHead);
    renderDeep();
    renderRules();
    renderPract();
  }

  function renderCatHead(cat, i) {
    $("vlCH-" + cat.key).innerHTML =
      '<span class="vlcat__no">' + (i + 1) + "</span><h2>" + esc(cat.name) + "</h2>" +
      levelBadge(catState(cat)) + '<span class="result__size">' + esc(cat.en) + "</span>";
  }

  function tileHTML(cat, i, s) {
    return '<button type="button" class="vlcat is-' + s.level + '" data-cat="' + cat.key + '"' +
             ' title="Prejsť na kategóriu ' + esc(cat.name) + '">' +
             '<span class="chk__i">' + ICON[s.level] + "</span>" +
             '<span class="vlcat__b">' +
               '<span class="vlcat__t">' + (i + 1) + " · " + esc(cat.name) + "</span>" +
               '<span class="vlcat__en">' + esc(cat.en) + "</span>" +
               '<span class="vlcat__n">' + esc(catNote(cat, s)) + "</span>" +
             "</span>" +
           "</button>";
  }

  function renderSummary() {
    var s = st.stats;
    var states = CATS.map(catState);
    var level = worst(states);
    var all = states.every(function (x) { return x.done; });
    var badge = level === "bad" ? '<span class="badge badge--bad">nájdené chyby</span>'
              : level === "warn" ? '<span class="badge badge--warn">s výhradami</span>'
              : all ? '<span class="badge badge--ok">bez chýb</span>'
              : '<span class="badge badge--skip">neúplné</span>';

    $("vlSummary").innerHTML =
      '<div class="result__head"><h2>výsledok validácie buildingSMART</h2>' + badge +
        '<span class="result__size">' + esc(st.name) + "</span></div>" +
      '<div class="result__body">' +
        '<div class="vlcats">' + CATS.map(function (cat, i) { return tileHTML(cat, i, states[i]); }).join("") + "</div>" +
        '<div class="stats">' +
          statHTML("entity", s.entities.toLocaleString("sk-SK")) +
          statHTML("objekty s GlobalId", s.objects.toLocaleString("sk-SK")) +
          statHTML("triedy", String(s.types)) +
        "</div>" +
        '<div class="dlrow">' +
          (all ? "" : '<button class="btn btn--sm" id="vlAll"' + (st.busy ? " disabled" : "") +
                      '>dokončiť všetky kontroly <span class="btn__arr">→</span></button>') +
          '<span class="mergehint">kategórie zodpovedajú stĺpcom validačnej služby validate.buildingsmart.org' +
            (all ? "" : " · spustí hĺbkovú kontrolu schémy aj pravidlá") + "</span>" +
        "</div>" +
      "</div>";
    if (!all) $("vlAll").addEventListener("click", runAll);
  }

  // ---- spoločná obsluha kontrol vo vlákne -----------------------------------
  // Všetky bežia v tom istom vlákne (Python sa nedá spustiť dvakrát naraz), takže
  // kým jedna beží, ostatné majú tlačidlo vypnuté.
  // pri IDS sa prekreslia aj panely so súbormi — ich tlačidlá počas behu nejdú
  function renderJobs() {
    if (st.mode === "bsdd" && st.file && st.checks) {
      if (st.pipe === st.file) renderPipeline();
      // celá kontrola práve skončila — výsledky sa vykreslia celé nanovo
      else if (st.shown !== st.file || $("vlApp").hidden) showResults();
      else renderBsdd();
    }
    renderIds();
  }

  // priebeh — prekreslí sa len časť, ktorá práve beží
  function renderBusy() {
    if (st.pipe === st.file && st.mode === "bsdd") renderPipeline();
    else if (st.busy === "validate") renderDeep();
    else if (st.busy === "rules") renderRules();
    else if (st.busy === "ids") renderIdsJob();
  }

  // výsledky všetkých kontrol vo vlákne — patria k jednému modelu
  function resetJobs() {
    clearInterval(st.timer);
    engine.stop();
    st.deep = null; st.deepState = "idle"; st.deepMs = 0;
    st.rules = null; st.rulesState = "idle"; st.rulesMs = 0; st.rulesInfo = null;
    st.ids = null; st.idsState = "idle"; st.idsMs = 0;
    st.busy = null; st.msg = ""; st.prog = null; st.err = {}; st.queue = []; st.pipe = null;
  }

  function tick() {
    var el = $("vlElapsed");
    if (el) el.textContent = "beží " + Math.round((Date.now() - st.t0) / 1000) + " s";
  }

  // Priebeh: pri kontrole podľa schémy vieme ukázať len text, pri pravidlách aj
  // koľký z 104 predpisov práve beží, pri IDS koľká špecifikácia.
  function busyHTML(stopId, unit) {
    var pct = st.prog && st.prog.total ? Math.round(st.prog.done / st.prog.total * 100) : null;
    return '<div class="deep__run"><div class="spinner"></div>' +
             '<div class="deep__st"><div class="deep__msg">' + esc(st.msg || "pripravujem…") + "</div>" +
               '<div class="help" id="vlElapsed">beží 0 s</div>' +
               (pct == null ? "" :
                 '<div class="pbar pbar--chk"><i style="width:' + pct + '%"></i></div>' +
                 '<div class="help">' + st.prog.done + " / " + st.prog.total + " " +
                   (unit || "pravidiel") + "</div>") +
             "</div>" +
             '<button class="btn btn--sm btn--ghost" id="' + stopId + '">zrušiť</button>' +
           "</div>";
  }

  function readBuf(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error("Súbor " + file.name + " sa nepodarilo prečítať.")); };
      reader.readAsArrayBuffer(file);
    });
  }

  // všetky kontroly vo vlákne — po nahratí samy, inak tlačidlom „dokončiť všetky
  // kontroly“; čo ešte nedobehlo, spustí jedno po druhom
  function runAll() {
    if (st.busy) return;
    st.queue = [];
    if (st.deepState !== "done") st.queue.push("validate");
    if (st.rulesState !== "done") st.queue.push("rules");
    if (st.queue.length) { st.pipe = st.file; startJob(st.queue.shift()); }
  }

  function startJob(kind) {
    if (!st.file || st.busy) return;
    if (kind === "ids" && !st.idsFile) return;
    st.busy = kind; st.msg = "čítam súbor…"; st.prog = null;
    st.err[kind] = "";
    if (kind === "validate") { st.deepState = "running"; st.deep = null; }
    else if (kind === "rules") { st.rulesState = "running"; st.rules = null; st.rulesInfo = null; }
    else { st.idsState = "running"; st.ids = null; }
    st.t0 = Date.now();
    renderJobs();
    clearInterval(st.timer);
    st.timer = setInterval(tick, 1000);

    var files = [st.file];
    if (kind === "ids") files.push(st.idsFile);
    Promise.all(files.map(readBuf))
      .then(function (bufs) {
        if (st.busy !== kind) return;          // medzitým zrušené
        var msg = { type: kind, buf: bufs[0] };
        if (kind === "ids") msg.ids = bufs[1];
        engine.run(msg, bufs, onMessage);
      })
      .catch(function (err) { if (st.busy === kind) failJob(kind, err.message); });
  }

  function onMessage(msg) {
    var kind = st.busy;
    if (msg.type === "progress") {
      st.msg = msg.text;
      if (msg.total) st.prog = { done: msg.done || 0, total: msg.total };
      var el = document.querySelector(".deep__msg");
      if (el && !msg.total) el.textContent = msg.text;
      else renderBusy();
      return;
    }
    clearInterval(st.timer);
    st.busy = null;
    if (msg.type === "result") {
      st.deepMs = msg.ms;
      st.deep = deepChecks(msg.statements);
      st.deepState = "done";
    } else if (msg.type === "rulesResult") {
      st.rulesMs = msg.ms;
      st.rules = ruleChecks(msg.data);
      st.rulesInfo = msg.data;
      st.rulesState = "done";
    } else if (msg.type === "idsResult") {
      st.idsMs = msg.ms;
      st.ids = msg.data;
      st.idsState = "done";
    } else if (msg.type === "error") {
      if (msg.detail) console.error(msg.detail);
      failJob(kind, msg.message);
      return;
    }
    if (st.queue.length) startJob(st.queue.shift());
    else { st.pipe = null; renderJobs(); }
  }

  function failJob(kind, message) {
    clearInterval(st.timer);
    st.busy = null;
    st.err[kind] = message;
    setState(kind, "error");
    // pri celej kontrole sa pokračuje ďalším krokom — chyba sa ukáže vo výsledkoch
    if (st.queue.length) { startJob(st.queue.shift()); return; }
    st.pipe = null;
    renderJobs();
  }

  function stopJob() {
    clearInterval(st.timer);
    engine.stop();       // vlákno sa ukončí, knižnice sa pri ďalšom behu načítajú znova
    setState(st.busy, "idle");
    st.busy = null; st.msg = ""; st.prog = null; st.queue = []; st.pipe = null;
    renderJobs();
  }

  function setState(kind, state) {
    if (kind === "validate") st.deepState = state;
    else if (kind === "rules") st.rulesState = state;
    else if (kind === "ids") st.idsState = state;
  }

  function errNote(kind) {
    return st.err[kind] ? '<div class="note note--bad"><span class="note__i">✕</span><span>' +
                          esc(st.err[kind]) + "</span></div>" : "";
  }

  function sizeNote(minutes) {
    var mb = st.size / (1024 * 1024);
    if (mb <= BIG_MB) return "";
    return '<div class="note note--warn"><span class="note__i">!</span><span>Súbor má ' +
           Math.round(mb) + " MB. Kontrola drží celý model v pamäti prehliadača — " +
           (minutes ? "pri takejto veľkosti počítajte s desiatkami minút a " : "pri takejto veľkosti ") +
           "môže zlyhať na nedostatok pamäte.</span></div>";
  }

  // karta kategórie, do ktorej sa kreslí výsledok z vlákna (null = nie je zobrazená)
  function jobBox(key) {
    return st.shown === st.file ? $("vlJob-" + key) : null;
  }

  // ---- 2 · schéma IFC — hĺbková kontrola ------------------------------------
  function renderDeep() {
    var box = jobBox("schema");
    if (!box) return;
    var head = '<div class="vlsub">hĺbková kontrola · ifcopenshell.validate';

    if (st.busy === "validate") {
      box.innerHTML = head + "</div>" + busyHTML("vlStop");
      $("vlStop").addEventListener("click", stopJob);
      return;
    }

    if (st.deepState === "done" && st.deep) {
      box.innerHTML =
        head + " · " + (st.deepMs / 1000).toFixed(1) + " s</div>" +
        '<div class="chks">' + st.deep.map(checkHTML).join("") + "</div>" +
        '<div class="dlrow">' +
          '<button class="btn btn--sm btn--ghost" id="vlRun"' + (st.busy ? " disabled" : "") +
            ">spustiť znova</button>" +
          '<span class="mergehint">jadro ifcopenshell.validate — rovnaké ako v službe buildingSMART</span>' +
        "</div>";
      $("vlRun").addEventListener("click", function () { startJob("validate"); });
      return;
    }

    box.innerHTML =
      head + "</div>" +
      "<p class=\"help\">Rýchla kontrola overí len triedy, počty atribútov a GlobalId. Úplný stĺpec " +
      "<b>IFC Schema</b> dá až <b>ifcopenshell.validate</b> — to isté jadro, ktoré používa validačná " +
      "služba buildingSMART: dátové typy atribútov, kardinality, výčtové hodnoty, SELECT typy a " +
      "pravidlá WHERE zo schémy EXPRESS.</p>" +
      errNote("validate") + sizeNote(false) +
      '<div class="dlrow">' +
        '<button class="btn btn--sm" id="vlRun"' + (st.busy ? " disabled" : "") +
          '>spustiť hĺbkovú kontrolu <span class="btn__arr">→</span></button>' +
        '<span class="mergehint">prvé spustenie stiahne ~25 MB knižnice · súbor zostáva vo vašom počítači</span>' +
      "</div>";
    $("vlRun").addEventListener("click", function () { startJob("validate"); });
  }

  // ---- 3 · normatívne pravidlá ----------------------------------------------
  function rulesStats(s) {
    return '<div class="stats">' +
             statHTML("pravidlá", String(s.total)) +
             statHTML("prešlo", String(s.passed || 0)) +
             statHTML("neprešlo", String(s.failed || 0)) +
             statHTML("nevyhodnotené", String(s.error || 0)) +
             statHTML("vypnuté", String(s.skipped || 0)) +
           "</div>";
  }

  function renderRules() {
    var box = jobBox("norm");
    if (!box) return;
    var head = '<div class="vlsub">ifc-gherkin-rules · Implementer Agreements a Informal Propositions';

    if (st.busy === "rules") {
      box.innerHTML = head + "</div>" + busyHTML("vlRStop");
      $("vlRStop").addEventListener("click", stopJob);
      renderPract();
      return;
    }

    if (st.rulesState === "done" && st.rules) {
      box.innerHTML =
        head + " · " + (st.rulesMs / 1000).toFixed(0) + " s</div>" +
        rulesStats(st.rules.stat.norm) +
        '<div class="chks">' + st.rules.norm.map(checkHTML).join("") + "</div>" +
        '<div class="dlrow">' +
          '<button class="btn btn--sm btn--ghost" id="vlRRun"' + (st.busy ? " disabled" : "") +
            ">spustiť znova</button>" +
          '<span class="mergehint">vypnuté pravidlá sú tak označené priamo v repozitári buildingSMART · ' +
            "najviac 25 nálezov na pravidlo</span>" +
        "</div>";
      $("vlRRun").addEventListener("click", function () { startJob("rules"); });
      return;
    }

    box.innerHTML =
      head + "</div>" +
      "<p class=\"help\">Spustí <b>ifc-gherkin-rules</b> — 104 predpisov z validačnej služby " +
      "buildingSMART. Jedným behom sa vyhodnotia normatívne pravidlá (táto kategória) aj " +
      "odporúčané praktiky (kategória 4).</p>" +
      errNote("rules") + sizeNote(true) +
      '<div class="note"><span class="note__i">i</span><span>Pravidlá pracujú s celým modelom, ' +
        "takže beh je pomalší než kontrola schémy — pri modeli so 100 tisíc entitami " +
        "rádovo dve minúty. Priebeh vidíte počas behu a dá sa zrušiť.</span></div>" +
      '<div class="dlrow">' +
        '<button class="btn btn--sm" id="vlRRun"' + (st.busy ? " disabled" : "") +
          '>spustiť pravidlá <span class="btn__arr">→</span></button>' +
        '<span class="mergehint">prvé spustenie stiahne ~25 MB knižnice · súbor zostáva vo vašom počítači</span>' +
      "</div>";
    $("vlRRun").addEventListener("click", function () { startJob("rules"); });
  }

  // ---- 4 · odporúčané praktiky — výsledok toho istého behu pravidiel --------
  function renderPract() {
    var box = jobBox("pract");
    if (!box) return;
    var head = '<div class="vlsub">ifc-gherkin-rules · Industry Practices';

    if (st.busy === "rules") {
      box.innerHTML = head + "</div>" +
        '<div class="deep__run"><div class="spinner"></div>' +
          '<div class="deep__msg">vyhodnocuje sa spolu s normatívnymi pravidlami…</div></div>';
      return;
    }

    if (st.rulesState === "done" && st.rules) {
      box.innerHTML =
        head + "</div>" +
        rulesStats(st.rules.stat.pract) +
        '<div class="chks">' + st.rules.pract.map(checkHTML).join("") + "</div>";
      return;
    }

    box.innerHTML =
      head + "</div>" +
      "<p class=\"help\">Pravidlá odporúčaných praktík sú súčasťou <b>ifc-gherkin-rules</b> a vyhodnotia " +
      "sa jedným behom s normatívnymi pravidlami.</p>" +
      errNote("rules") +
      '<div class="dlrow">' +
        '<button class="btn btn--sm" id="vlPRun"' + (st.busy ? " disabled" : "") +
          '>spustiť pravidlá <span class="btn__arr">→</span></button>' +
      "</div>";
    $("vlPRun").addEventListener("click", function () { startJob("rules"); });
  }

  // Hlásenia z ifcopenshell rozdelíme na dve kontroly: hodnoty atribútov
  // (typ, kardinalita, výčet) a pravidlá WHERE zo schémy EXPRESS.
  function deepChecks(statements) {
    var cAttr = chk("dschema", "Hodnoty atribútov podľa schémy",
      "Dátové typy, kardinality agregácií, výčtové hodnoty a SELECT typy.");
    var cRule = chk("drule", "Pravidlá WHERE",
      "Podmienky, ktoré schéma EXPRESS predpisuje pre triedy a globálne pravidlá.");

    statements.forEach(function (s) {
      var c = (s.kind === "schema") ? cAttr : cRule;
      var who = s.id ? "#" + s.id + (s.cls ? " " + s.cls.toUpperCase() : "") : "";
      var what = s.attribute ? " · " + s.attribute : "";
      // hlásenia z knižnice sú viacriadkové (rozpis atribútu, výpis pravidla) —
      // do zoznamu ich stlačíme na jeden riadok
      var msg = (s.message || "").replace(/\s+/g, " ").trim();
      var short = msg.length > 240 ? msg.slice(0, 240) + "…" : msg;
      add(c, (who ? who + what + " — " : "") + short, -1, s.message, s.id);
    });

    seal(cAttr, "bad", "všetky hodnoty zodpovedajú schéme",
         function (n) { return n.toLocaleString("sk-SK") + " " + plural(n, "chyba", "chyby", "chýb"); });
    seal(cRule, "bad", "žiadne porušené pravidlo",
         function (n) { return n.toLocaleString("sk-SK") + " " + plural(n, "porušenie", "porušenia", "porušení"); });
    return [cAttr, cRule];
  }

  // „ALB004 - Alignment in spatial structure relationships“ → ALB004
  function ruleCode(feature) { return String(feature || "").split(" - ")[0].trim(); }

  // Výsledky pravidiel do kategórií 3 a 4 — po jednej kontrole na každé pravidlo,
  // ktoré neprešlo, s návodom na opravu z js/validate-fixes.js. Kategóriu určuje
  // tag pravidla @industry-practice; tie validačná služba hlási ako WARNING,
  // ostatné (Implementer Agreements, Informal Propositions) ako ERROR.
  function ruleChecks(data) {
    var out = { norm: [], pract: [], stat: { norm: { total: 0 }, pract: { total: 0 } } };
    var ip = {}, byRule = {};

    (data.features || []).forEach(function (f) {
      ip[ruleCode(f.name)] = !!f.ip;
      var s = out.stat[f.ip ? "pract" : "norm"];
      s[f.status] = (s[f.status] || 0) + 1;
      s.total++;
    });
    if (!data.features) {
      out.stat.norm = data.status || {};
      out.stat.norm.total = data.rules || 0;
    }
    function catOf(code, severity) {
      return code in ip ? (ip[code] ? "pract" : "norm") : (severity === "WARNING" ? "pract" : "norm");
    }

    (data.outcomes || []).forEach(function (o) {
      var code = ruleCode(o.feature);
      var c = byRule[code];
      if (!c) {
        var fx = window.ValidateFixes.rule(code);
        var name = String(o.feature || "").split(" - ").slice(1).join(" - ");
        c = byRule[code] = chk("r:" + code, code + (fx.title ? " · " + fx.title : ""),
                               name ? "pravidlo buildingSMART: " + name : "");
        c.rule = true; c.fix = fx.fix; c.link = fx.url;
        out[catOf(code, o.severity)].push(c);
      }
      var parts = [];
      if (o.expected) parts.push("očakávané: " + o.expected);
      if (o.observed) parts.push("zistené: " + o.observed);
      var line = (o.inst ? "#" + o.inst : "") + (o.inst && parts.length ? " — " : "") + parts.join(" · ");
      var full = (o.feature || "") + "\n" + (o.code ? o.code + "\n" : "") + parts.join("\n");
      add(c, line.length > 260 ? line.slice(0, 260) + "…" : (line || o.code || code), -1, full, o.inst);
    });

    ["norm", "pract"].forEach(function (k) {
      var level = k === "pract" ? "warn" : "bad";
      out[k].forEach(function (c) {
        seal(c, level, "", function (n) {
          return n.toLocaleString("sk-SK") + " " + plural(n, "nález", "nálezy", "nálezov");
        });
      });
      if (!out[k].length) {
        var okc = chk("rok-" + k, "Žiadne porušené pravidlo",
          k === "pract" ? "Model zodpovedá všetkým vyhodnoteným odporúčaným praktikám."
                        : "Model spĺňa všetky vyhodnotené normatívne pravidlá.");
        out[k].push(okc);
      }
    });

    // Nevyhodnotené pravidlá nie sú chybou modelu — model len nebolo čím overiť.
    var skip = { norm: null, pract: null };
    (data.errored || []).forEach(function (name) {
      var k = catOf(ruleCode(name), "");
      if (!skip[k]) {
        skip[k] = chk("rskip-" + k, "Nevyhodnotené pravidlá",
          "Pravidlá, ktoré v prehliadači nedobehli — napríklad preto, že potrebujú knižnicu, " +
          "ktorá sa do WebAssembly nedá preložiť (georeferencovanie, priestorový index).");
        skip[k].fix = "Toto nie je chyba modelu. Ak sa vás pravidlá týkajú (napr. georeferencovanie), " +
                      "overte súbor aj v oficiálnej službe validate.buildingsmart.org.";
        skip[k].fixLabel = "čo urobiť";
        out[k].push(skip[k]);
      }
      add(skip[k], name);
    });
    ["norm", "pract"].forEach(function (k) {
      if (!skip[k]) return;
      skip[k].level = "skip";
      skip[k].note = skip[k].total + " " + plural(skip[k].total, "pravidlo", "pravidlá", "pravidiel");
    });
    return out;
  }

  // =========================================================================
  //  Kontrola podľa IDS
  // =========================================================================
  var CARD = { required: "povinná", optional: "voliteľná", prohibited: "zakázaná" };
  var FACET = { Entity: "trieda", Attribute: "atribút", Property: "vlastnosť",
                Classification: "klasifikácia", Material: "materiál", PartOf: "súčasť" };
  var IDS_ICON = '<svg class="drop__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/><path d="M9 13l2 2 4-4"/></svg>';

  function kB(n) { return Math.round(n / 1024).toLocaleString("sk-SK") + " kB"; }

  // Súbor IDS sa hneď len prečíta ako XML — názov a počet špecifikácií pomôžu
  // overiť, že je nahratý ten správny. Vyhodnotenie (aj kontrola voči schéme
  // IDS 1.0) prebehne až vo vlákne.
  function handleIds(file) {
    if (st.busy === "ids") stopJob();
    st.idsFile = file; st.idsMeta = null;
    st.ids = null; st.idsState = "idle"; st.err.ids = "";
    var reader = new FileReader();
    reader.onload = function () {
      if (st.idsFile !== file) return;
      st.idsMeta = idsMeta(reader.result);
      render();
    };
    reader.onerror = function () {
      if (st.idsFile !== file) return;
      st.idsMeta = { error: "Súbor sa nepodarilo prečítať." };
      render();
    };
    reader.readAsText(file);
    render();
  }

  function idsMeta(text) {
    var doc;
    try { doc = new DOMParser().parseFromString(text, "application/xml"); }
    catch (e) { return { error: "Súbor nie je platné XML." }; }
    var root = doc.documentElement;
    if (!root || doc.getElementsByTagName("parsererror").length)
      return { error: "Súbor nie je platné XML." };
    if (root.localName !== "ids")
      return { error: "Toto nie je súbor IDS — koreňový prvok je <" + root.localName + ">, očakáva sa <ids>." };
    function infoOf(name) {
      var info = root.getElementsByTagNameNS("*", "info")[0];
      var el = info && info.getElementsByTagNameNS("*", name)[0];
      return el ? el.textContent.trim() : "";
    }
    var specs = root.getElementsByTagNameNS("*", "specification");
    var versions = {};
    for (var i = 0; i < specs.length; i++)
      (specs[i].getAttribute("ifcVersion") || "").split(/\s+/).forEach(function (v) { if (v) versions[v] = 1; });
    return {
      title: infoOf("title"), author: infoOf("author"), version: infoOf("version"),
      date: infoOf("date"), purpose: infoOf("purpose"), milestone: infoOf("milestone"),
      description: infoOf("description"),
      specs: specs.length, versions: Object.keys(versions)
    };
  }

  function bindDrop(el, input, onFile) {
    el.addEventListener("click", function () { $(input).click(); });
    el.addEventListener("dragover", function (e) { e.preventDefault(); el.classList.add("is-over"); });
    el.addEventListener("dragleave", function () { el.classList.remove("is-over"); });
    el.addEventListener("drop", function (e) {
      e.preventDefault(); el.classList.remove("is-over");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
    });
  }

  function idsPanel(tag, title, sub, body) {
    return '<div class="panel__head"><span class="panel__tag">' + esc(tag) + "</span>" +
             '<span class="panel__title">' + esc(title) + "</span>" +
             '<span class="panel__sub">' + esc(sub) + "</span></div>" +
           '<div class="panel__body">' + body + "</div>";
  }

  function idsDrop(id, main, hint, icon) {
    return '<div class="drop" id="' + id + '">' + icon +
             '<div class="drop__main">' + esc(main) + "</div>" +
             '<div class="drop__hint">' + hint + "</div></div>";
  }

  function fileRow(k, v) {
    return v ? '<div class="idsf__r"><span class="idsf__k">' + esc(k) + "</span><span>" + esc(v) + "</span></div>" : "";
  }

  function renderIdsInputs() {
    // model
    var m = $("vlIdsModel");
    if (!st.file) {
      m.innerHTML = idsPanel("model", "nahrajte IFC", ".ifc · .step · .stp",
        idsDrop("vlIdsMDrop", "presuňte sem model", "alebo kliknite pre výber", UPLOAD_ICON));
      bindDrop($("vlIdsMDrop"), "fileC", handleFile);
    } else {
      var idx = st.idx, schema = idx ? idx.schema : st.ids ? st.ids.schema : "";
      m.innerHTML = idsPanel("model", st.name, kB(st.size),
        '<div class="idsf">' +
          fileRow("schéma", schema) +
          fileRow("entity", idx ? idx.entityCount.toLocaleString("sk-SK") : "") +
          (schema ? "" : '<div class="help">model sa prečíta až pri vyhodnotení</div>') +
        "</div>" +
        '<div class="idsf__act"><button class="btn btn--sm btn--ghost" id="vlIdsMChg" type="button"' +
          (st.busy ? " disabled" : "") + ">iný model</button></div>");
      $("vlIdsMChg").addEventListener("click", function () { $("fileC").click(); });
    }

    // špecifikácia
    var p = $("vlIdsSpec"), meta = st.idsMeta;
    p.classList.toggle("is-error", !!(meta && meta.error));
    if (!st.idsFile) {
      p.innerHTML = idsPanel("ids", "nahrajte IDS", ".ids · .xml",
        idsDrop("vlIdsSDrop", "presuňte sem súbor IDS", "alebo kliknite pre výber · <b>IDS 1.0</b> od buildingSMART", IDS_ICON));
      bindDrop($("vlIdsSDrop"), "fileI", handleIds);
      return;
    }
    var body;
    if (!meta) body = '<div class="help">čítam súbor…</div>';
    else if (meta.error) body = '<div class="note note--bad"><span class="note__i">✕</span><span>' + esc(meta.error) + "</span></div>";
    else body =
      '<div class="idsf">' +
        fileRow("názov", meta.title || "bez názvu") +
        fileRow("špecifikácie", String(meta.specs)) +
        fileRow("schémy", meta.versions.join(" · ")) +
        fileRow("autor", meta.author) +
        fileRow("verzia", meta.version) +
        fileRow("dátum", meta.date) +
        fileRow("fáza", meta.milestone) +
        fileRow("účel", meta.purpose) +
        (meta.description ? '<div class="idsf__d">' + esc(meta.description) + "</div>" : "") +
      "</div>";
    p.innerHTML = idsPanel("ids", st.idsFile.name, kB(st.idsFile.size), body +
      '<div class="idsf__act"><button class="btn btn--sm btn--ghost" id="vlIdsSChg" type="button"' +
        (st.busy === "ids" ? " disabled" : "") + ">iný súbor IDS</button></div>");
    $("vlIdsSChg").addEventListener("click", function () { $("fileI").click(); });
  }

  function renderIdsJob() {
    var box = $("vlIds");
    var meta = st.idsMeta;

    if (st.busy === "ids") {
      box.innerHTML = '<div class="card__head">vyhodnotenie IDS</div>' + '<div class="deep__body">' +
                      busyHTML("vlIStop", "špecifikácií") + "</div>";
      $("vlIStop").addEventListener("click", stopJob);
      return;
    }

    if (st.idsState === "done" && st.ids) {
      box.innerHTML = idsResultHTML(st.ids);
      $("vlIRun").addEventListener("click", function () { startJob("ids"); });
      return;
    }

    var ready = st.file && st.idsFile && meta && !meta.error;
    var why = !st.file && !st.idsFile ? "nahrajte model a súbor IDS"
            : !st.file ? "nahrajte model" : !st.idsFile ? "nahrajte súbor IDS"
            : !meta ? "čítam súbor IDS…" : meta.error ? "súbor IDS sa nedá použiť" : "";
    box.innerHTML =
      '<div class="card__head">vyhodnotenie IDS</div>' +
      '<div class="deep__body">' +
        "<p class=\"help\">Každá <b>špecifikácia</b> v IDS hovorí, na ktoré prvky modelu sa vzťahuje " +
        "(napr. všetky steny) a čo musia mať (atribút, vlastnosť v property sete, klasifikáciu, " +
        "materiál, zaradenie). Vyhodnotí ich <b>IfcTester</b> z IfcOpenShellu a pri každej " +
        "požiadavke vypíše prvky, ktoré ju nespĺňajú.</p>" +
        errNote("ids") + (st.file ? sizeNote(false) : "") +
        '<div class="dlrow">' +
          '<button class="btn btn--sm" id="vlIRun"' + (ready && !st.busy ? "" : " disabled") +
            '>vyhodnotiť IDS <span class="btn__arr">→</span></button>' +
          '<span class="mergehint">' + (why ? esc(why) + " · " : "") +
            "prvé spustenie stiahne ~25 MB knižnice · súbory zostávajú vo vašom počítači</span>" +
        "</div>" +
      "</div>";
    $("vlIRun").addEventListener("click", function () { startJob("ids"); });
  }

  // Úroveň špecifikácie: mimo schémy modelu sa nevyhodnocuje (IDS ju obmedzuje
  // atribútom ifcVersion), inak rozhoduje výsledok z IfcTesteru.
  function specLevel(sp) {
    if (!sp.isIfcVersion) return "skip";
    return sp.status ? "ok" : "bad";
  }

  function specNote(sp, level) {
    if (level === "skip") return "mimo schémy modelu";
    var n = sp.applicable;
    var prv = function (k) { return k.toLocaleString("sk-SK") + " " + plural(k, "prvok", "prvky", "prvkov"); };
    if (sp.cardinality === "prohibited")
      return n ? prv(n) + " v modeli, hoci nesmú byť" : "žiadny zakázaný prvok";
    if (!n) return sp.cardinality === "required" ? "v modeli sa nenašiel žiadny prvok" : "netýka sa žiadneho prvku";
    if (!sp.failed) return prv(n) + " · všetky vyhovujú";
    return sp.failed.toLocaleString("sk-SK") + " z " + prv(n) + " nevyhovuje";
  }

  function entLine(e) {
    return "#" + e.id + " " + (e.cls || "") + (e.name ? " „" + e.name + "“" : "");
  }

  function entItems(list, total, withReason) {
    var c = chk("", "", "");
    list.forEach(function (e) {
      add(c, entLine(e) + (withReason && e.reason ? " — " + e.reason : ""), -1,
          entLine(e) + (e.gid ? "\nGlobalId " + e.gid : "") + (e.reason ? "\n" + e.reason : ""), e.id);
    });
    c.total = Math.max(total, c.total);
    return itemsHTML(c);
  }

  function specHTML(sp, data) {
    var level = specLevel(sp);
    var meta = [CARD[sp.cardinality] || sp.cardinality];
    if (sp.applicability.length) meta.push("platí pre: " + sp.applicability.join(" · "));
    meta.push(sp.ifcVersion.join(" · "));

    var body = "";
    if (sp.description) body += '<div class="chk__d">' + esc(sp.description) + "</div>";
    if (sp.instructions) body += '<div class="chk__d"><i>pokyn:</i> ' + esc(sp.instructions) + "</div>";
    body += '<div class="ids__meta">' + esc(meta.join("  ·  ")) + "</div>";

    if (level === "skip") {
      body += '<div class="chk__d">Špecifikácia platí pre ' + esc(sp.ifcVersion.join(", ")) +
              ", model je v schéme " + esc(data.schema) + " — nevyhodnocuje sa.</div>";
    } else if (sp.cardinality === "prohibited") {
      if (sp.applicable) body += entItems(sp.found, sp.applicable, false);
    } else if (sp.requirements.length) {
      body += '<ul class="ids__reqs">' + sp.requirements.map(function (r) {
        // bez vyhovujúcich prvkov sa požiadavka nemala na čom overiť
        var rl = !sp.applicable ? "skip" : r.status ? "ok" : "bad";
        return '<li class="is-' + rl + '">' +
                 '<div class="ids__rh"><span class="ids__ri">' + ICON[rl] + "</span>" +
                   '<span class="ids__ft">' + esc(FACET[r.facet] || r.facet) + "</span>" +
                   "<span>" + esc(r.text) + "</span>" +
                   (r.fail ? '<span class="chk__n">' + r.fail.toLocaleString("sk-SK") + " " +
                             plural(r.fail, "nevyhovuje", "nevyhovujú", "nevyhovuje") + "</span>" : "") +
                 "</div>" +
                 (r.fail ? entItems(r.failures, r.fail, true) : "") +
               "</li>";
      }).join("") + "</ul>";
    }

    return '<div class="chk is-' + level + '">' +
             '<span class="chk__i">' + ICON[level] + "</span>" +
             '<div class="chk__b">' +
               '<div class="chk__t">' + esc(sp.name || "bez názvu") +
                 '<span class="chk__n">' + esc(specNote(sp, level)) + "</span></div>" +
               body +
             "</div>" +
           "</div>";
  }

  function idsResultHTML(data) {
    var specs = data.specs || [];
    var cnt = { ok: 0, bad: 0, skip: 0 }, elems = 0, failed = 0;
    specs.forEach(function (sp) {
      var l = specLevel(sp);
      cnt[l]++;
      if (l === "skip") return;
      elems += sp.applicable;
      failed += sp.cardinality === "prohibited" ? sp.applicable : sp.failed;
    });
    var title = (data.info && data.info.title) || (st.idsFile && st.idsFile.name) || "IDS";
    return '<div class="result__head"><h2>vyhodnotenie IDS</h2>' +
             (cnt.bad ? '<span class="badge badge--bad">nesplnené</span>'
              : cnt.ok ? '<span class="badge badge--ok">splnené</span>'
              : '<span class="badge badge--warn">nič na vyhodnotenie</span>') +
             '<span class="result__size">' + (st.idsMs / 1000).toFixed(1) + " s</span></div>" +
           '<div class="result__body">' +
             '<div class="ids__title">' + esc(title) + '<span class="chk__n">model ' +
               esc(st.name) + " · " + esc(data.schema) + "</span></div>" +
             '<div class="stats">' +
               statHTML("špecifikácie", String(specs.length)) +
               statHTML("splnené", String(cnt.ok)) +
               statHTML("nesplnené", String(cnt.bad)) +
               (cnt.skip ? statHTML("mimo schémy", String(cnt.skip)) : "") +
               statHTML("overené prvky", elems.toLocaleString("sk-SK")) +
               statHTML("nevyhovujúce", failed.toLocaleString("sk-SK")) +
             "</div>" +
             (specs.length ? '<div class="chks">' + specs.map(function (sp) { return specHTML(sp, data); }).join("") + "</div>"
                           : '<div class="note"><span class="note__i">i</span><span>IDS neobsahuje žiadnu špecifikáciu.</span></div>') +
             '<div class="dlrow">' +
               '<button class="btn btn--sm btn--ghost" id="vlIRun"' + (st.busy ? " disabled" : "") +
                 ">vyhodnotiť znova</button>" +
               '<span class="mergehint">IfcTester · texty požiadaviek a dôvodov sú v angličtine, ' +
                 "ako ich vracia knižnica · najviac 200 prvkov na požiadavku</span>" +
             "</div>" +
           "</div>";
  }

  function renderIds() {
    renderIdsInputs();
    renderIdsJob();
  }

  // =========================================================================
  //  Prepínanie druhu kontroly
  // =========================================================================
  function loadMode() {
    try { return localStorage.getItem(MODE_KEY) === "ids" ? "ids" : "bsdd"; }
    catch (e) { return "bsdd"; }
  }

  function setMode(mode) {
    if (mode === st.mode) return;
    st.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* nevadí */ }
    render();
  }

  function render() {
    var ids = st.mode === "ids";
    Array.prototype.forEach.call($("vlMode").querySelectorAll(".vlmode__b"), function (b) {
      var on = b.getAttribute("data-mode") === st.mode;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("vlIdsView").hidden = !ids;
    if (ids) {
      $("vlHead").hidden = false;
      panel().hidden = true;
      $("vlApp").hidden = true;
      syncBar();
      renderIds();
      return;
    }
    if (!st.file) renderDrop("");
    else if (st.checks) {
      // hĺbková kontrola aj pravidlá sa spustia samy — pre každý súbor raz; po
      // zrušení alebo chybe sa znova púšťajú tlačidlom
      if (st.autoRun !== st.file && !st.busy) {
        st.autoRun = st.file;
        runAll();
      }
      if (st.pipe === st.file) renderPipeline(); else showResults();
    }
    else {
      // rýchla kontrola beží alebo ešte nezačala — ukáže sa jej priebeh
      $("vlHead").hidden = false;
      panel().hidden = false;
      $("vlApp").hidden = true;
      syncBar();
      if (st.analyzing !== st.file) analyzeFile();
    }
  }

  function syncBar() {
    if (!window.AppBar) return;
    AppBar.setStatus(st.file ? st.name : "kontrola súboru");
    AppBar.setBadge(st.mode === "ids" ? "IDS" : "");
  }

  // =========================================================================
  //  Prepojenie na rozhranie
  // =========================================================================
  $("fileC").addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = "";
  });
  $("fileI").addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) handleIds(e.target.files[0]);
    e.target.value = "";
  });
  $("vlMode").addEventListener("click", function (e) {
    var b = e.target.closest(".vlmode__b");
    if (b) setMode(b.getAttribute("data-mode"));
  });

  /* Preklik nálezu do prehliadača kódu. Otvorí sa ten istý súbor a v ňom entita,
     ktorej sa nález týka; keď číslo entity nepoznáme (napr. visiaci odkaz),
     skočí sa na riadok, kde sa nález našiel. */
  function openInCode(id, line) {
    if (!st.file || !window.ViewerTool || !window.ViewerTool.open) return;
    // kam sa má vrátiť tlačidlo v hornej lište — aj s posunom na ten istý nález
    var y = window.scrollY;
    window.ViewerTool.open({
      file: st.file, id: id, line: line,
      back: { label: "← späť na validáciu", go: function () {
        if (window.AppBar && AppBar.go) AppBar.go("validate");
        else location.hash = "#/validate";
        window.scrollTo(0, y);
      } }
    });
  }

  function onFinding(e) {
    var li = e.target.closest("li.is-link");
    if (!li) return;
    openInCode(+li.getAttribute("data-goid"), +li.getAttribute("data-goline"));
  }
  $("vlApp").addEventListener("click", onFinding);
  // dlaždica v súhrne posunie na kartu svojej kategórie
  $("vlSummary").addEventListener("click", function (e) {
    var b = e.target.closest(".vlcat");
    if (b) $("vlCat-" + b.getAttribute("data-cat")).scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("vlIds").addEventListener("click", onFinding);

  window.ValidateTool = {
    syncBar: syncBar,
    reset: function () {
      resetJobs();
      st.file = null; st.name = ""; st.size = 0; st.idx = null; st.analyzing = null;
      st.checks = null; st.stats = null;
      st.idsFile = null; st.idsMeta = null;
      render();
    }
  };

  render();
})();
