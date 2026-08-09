/* validate.js — nástroj na kontrolu IFC súboru.
 *
 * Kontrola má dve úrovne:
 *   1. rýchla — beží hneď po nahratí priamo tu v JS nad indexom z js/ifc-code.js:
 *      štruktúra súboru, verzia schémy, zápis entít, čísla entít, referencie,
 *      GlobalId a nepoužité entity;
 *   2. hĺbková — na vyžiadanie, v js/validate-pyodide.js: ifcopenshell.validate
 *      (typy hodnôt, kardinality, výčty, pravidlá WHERE), teda jadro oficiálnej
 *      validačnej služby buildingSMART. Sťahuje sa ~25 MB, preto až na kliknutie.
 *
 * Súbor nikam neodchádza — obe úrovne bežia vo vašom prehliadači.
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

  var st = {
    file: null, name: "", size: 0,
    idx: null, checks: null, stats: null,
    deep: null,                 // výsledok hĺbkovej kontroly
    deepState: "idle",          // idle | running | done | error
    deepMsg: "", deepMs: 0, timer: null, t0: 0
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
      run: function (buf, onMsg) {
        handler = onMsg;
        try { boot().postMessage({ type: "validate", buf: buf }, [buf]); }
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

  function progress(label, pct) {
    panel().classList.remove("is-error");
    setHead("súbor", pct == null ? "načítava sa" : "kontrolujem", pct == null ? "" : Math.round(pct * 100) + " %");
    $("vlBody").innerHTML =
      '<div class="drop drop--busy drop--tall">' +
        (pct == null ? '<div class="spinner"></div>' : "") +
        '<div class="drop__main">' + esc(label) + "</div>" +
        '<div class="drop__hint">' + esc(st.name) + " · " +
          Math.round(st.size / 1024).toLocaleString("sk-SK") + " kB</div>" +
        (pct == null ? "" : '<div class="pbar pbar--chk"><i style="width:' + Math.round(pct * 100) + '%"></i></div>') +
      "</div>";
  }

  function handleFile(file) {
    engine.stop();
    st.file = file; st.name = file.name; st.size = file.size;
    st.deep = null; st.deepState = "idle"; st.deepMsg = ""; st.deepMs = 0;
    progress("číta sa súbor…", null);
    var reader = new FileReader();
    reader.onload = function () {
      progress("analyzujem štruktúru súboru…", 0);
      var text = reader.result;
      C.indexFile(text, function (p) { progress("analyzujem štruktúru súboru…", p * 0.6); })
        .then(function (idx) {
          st.idx = idx;
          return analyze(idx, text, function (p) {
            progress("kontrolujem zápis a väzby…", 0.6 + p * 0.4);
          });
        })
        .then(function (res) {
          st.checks = res.checks; st.stats = res.stats;
          showResults();
        })
        .catch(function (err) { renderDrop(err.message); });
    };
    reader.onerror = function () { renderDrop("Chyba pri čítaní súboru."); };
    reader.readAsText(file);
  }

  // =========================================================================
  //  Rýchla kontrola (JS)
  // =========================================================================
  function chk(key, title, desc) {
    return { key: key, title: title, desc: desc, level: "ok", note: "", items: [], total: 0 };
  }
  // Nálezy sa zbierajú len po strop — u rozbitého súboru ich môžu byť milióny.
  function add(c, text, line, full) {
    c.total++;
    if (c.items.length < COLLECT_MAX)
      c.items.push({ text: text, line: line == null ? -1 : line, full: full || "" });
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
      var unknown = new Map();                     // neznáma trieda → počet
      var argsBad = new Map();                     // "TRIEDA n/m" → {count, line}
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
            if (seenId[id]) add(cIds, "Číslo #" + id + " je použité viackrát.", line);
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
            add(cSyntax, "#" + id + " " + type + " — zátvorky nie sú párové", line);
            i++; continue;
          }
          if (masked.slice(end + 1).trim()) {
            add(cSyntax, "#" + id + " " + type + " — za uzatváracou zátvorkou je ďalší text", line);
          }
          var args = C.splitTopLevel(body.slice(open + 1, end), masked.slice(open + 1, end));

          scanRefs(masked, line);

          // trieda a počet atribútov podľa registra schémy
          var info = A ? A.attrsFor(type, schema, args.length) : null;
          if (!info) unknown.set(type, (unknown.get(type) || 0) + 1);
          else {
            if (info.names.length !== args.length) {
              // koľko atribútov čaká práve schéma súboru (info mohlo sadnúť na inú verziu)
              var ref = A.attrsFor(type, schema, 0) || info;
              var key = type + " " + args.length + "/" + ref.names.length;
              var rec = argsBad.get(key);
              if (rec) rec.count++;
              else argsBad.set(key, { count: 1, line: line, type: type,
                                      got: args.length, want: ref.names.length });
            }
            if (info.names[0] === "GlobalId") {
              if (id <= maxId) rooted[id] = 1;
              var g = args.length ? args[0].trim() : "";
              if (g.charAt(0) !== "'" || g.charAt(g.length - 1) !== "'") {
                add(cGuid, "#" + id + " " + type + " — GlobalId nie je textová hodnota", line);
              } else {
                var v = g.slice(1, -1);
                if (!/^[0-9A-Za-z_$]{22}$/.test(v)) {
                  add(cGuid, "#" + id + " " + type + " — GlobalId '" + v + "' nemá tvar 22 znakov", line);
                } else if (guids.has(v)) {
                  add(cGuid, "#" + id + " " + type + " — GlobalId '" + v +
                             "' už má entita na riadku " + (guids.get(v) + 1), line);
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
        missRefs.forEach(function (line, r) {
          if (r <= maxId && defined[r]) return;
          add(cRefs, "Odkaz #" + r + " nesmeruje na žiadnu entitu v súbore.", line);
        });

        // nepoužité entity — nikto sa na ne neodkazuje a nie sú samostatnými objektmi
        for (var s = 0; s < n; s++) {
          var id = idx.stmtIds[s];
          if (id < 0 || id > maxId || !defined[id]) continue;
          if (refd[id] || rooted[id]) continue;
          add(cOrph, "#" + id + " " + idx.stmtTypes[s] + " — na entitu sa nikto neodkazuje", idx.stmtFrom[s]);
        }

        unknown.forEach(function (count, type) {
          add(cTypes, type + " — trieda nie je v registri schémy" + (count > 1 ? " (" + count + "×)" : ""));
        });
        argsBad.forEach(function (r) {
          add(cTypes, r.type + " — " + r.got + " " + plural(r.got, "atribút", "atribúty", "atribútov") +
                      ", schéma očakáva " + r.want + (r.count > 1 ? " (" + r.count + "×)" : ""), r.line);
        });

        seal(cSyntax, "bad", "všetky entity majú platný zápis",
             function (c) { return c + " " + plural(c, "chybný zápis", "chybné zápisy", "chybných zápisov"); });
        seal(cIds, "bad", "čísla entít sú jedinečné",
             function (c) { return c + " " + plural(c, "duplicita", "duplicity", "duplicít"); });
        seal(cRefs, "bad", "všetky odkazy smerujú na existujúce entity",
             function (c) { return c + " " + plural(c, "visiaci odkaz", "visiace odkazy", "visiacich odkazov"); });
        seal(cGuid, "bad", guids.size.toLocaleString("sk-SK") + " " +
             plural(guids.size, "objekt", "objekty", "objektov") + " s jedinečným GlobalId",
             function (c) { return c + " " + plural(c, "problém", "problémy", "problémov"); });
        seal(cTypes, "warn", "všetky triedy pozná register schémy",
             function (c) { return c + " " + plural(c, "trieda mimo očakávania", "triedy mimo očakávania", "tried mimo očakávania"); });
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
  //  Výsledok
  // =========================================================================
  var ICON = { ok: "✓", warn: "!", bad: "✕", info: "·", skip: "–" };

  function worst(checks) {
    var bad = false, warn = false;
    checks.forEach(function (c) {
      if (c.level === "bad") bad = true;
      else if (c.level === "warn") warn = true;
    });
    return bad ? "bad" : warn ? "warn" : "ok";
  }

  function itemsHTML(c) {
    if (!c.total) return "";
    var shown = c.items.slice(0, LIST_MAX);
    var rows = shown.map(function (it) {
      // celé hlásenie z knižnice býva na desiatky riadkov — v zozname je skrátené,
      // úplné znenie ukáže prehliadač v bublinovej nápovede
      return "<li" + (it.full ? ' title="' + esc(it.full) + '"' : "") + ">" +
             (it.line >= 0 ? '<span class="fnd__l">riadok ' + (it.line + 1) + "</span>" : "") +
             "<span>" + esc(it.text) + "</span></li>";
    }).join("");
    var rest = c.total - shown.length;
    return '<details class="chk__more"><summary>zobraziť nálezy (' +
             c.total.toLocaleString("sk-SK") + ")</summary>" +
             '<ul class="fnd">' + rows + "</ul>" +
             (rest > 0 ? '<div class="fnd__rest">…a ďalších ' + rest.toLocaleString("sk-SK") +
                         " — vypisuje sa prvých " + LIST_MAX + "</div>" : "") +
           "</details>";
  }

  function checkHTML(c) {
    return '<div class="chk is-' + c.level + '">' +
             '<span class="chk__i">' + ICON[c.level] + "</span>" +
             '<div class="chk__b">' +
               '<div class="chk__t">' + esc(c.title) +
                 (c.note ? '<span class="chk__n">' + esc(c.note) + "</span>" : "") + "</div>" +
               '<div class="chk__d">' + esc(c.desc) + "</div>" +
               itemsHTML(c) +
             "</div>" +
           "</div>";
  }

  function statHTML(k, v, vs) {
    return '<div class="stat"><div class="k">' + esc(k) + "</div>" +
           (vs ? '<div class="vs">' + esc(vs) + "</div>" : '<div class="v">' + esc(v) + "</div>") + "</div>";
  }

  function showResults() {
    var idx = st.idx, s = st.stats;
    $("vlHead").hidden = true;
    panel().hidden = true;
    $("vlApp").hidden = false;
    if (window.AppBar) AppBar.setStatus(st.name);

    $("vlChips").innerHTML =
      '<div class="m">schéma <b>' + esc(idx.schema) + "</b></div>" +
      (idx.lengthUnit !== "?" ? '<div class="m">jednotka <b>' + esc(idx.lengthUnit) + "</b></div>"
                              : '<div class="m is-warn">jednotka neurčená</div>') +
      '<div class="m">entity <b>' + s.entities.toLocaleString("sk-SK") + "</b></div>" +
      '<div class="m">triedy <b>' + s.types + "</b></div>" +
      '<div class="m">' + Math.round(st.size / 1024).toLocaleString("sk-SK") + " kB</div>";

    renderSummary();
    renderDeep();
  }

  function renderSummary() {
    var s = st.stats, level = worst(st.checks);
    var badge = level === "ok" ? '<span class="badge badge--ok">bez chýb</span>'
              : level === "warn" ? '<span class="badge badge--warn">s výhradami</span>'
              : '<span class="badge badge--bad">nájdené chyby</span>';
    var errs = 0, warns = 0;
    st.checks.forEach(function (c) {
      if (c.level === "bad") errs += c.total;
      else if (c.level === "warn") warns += c.total;
    });

    $("vlSummary").innerHTML =
      '<div class="result__head"><h2>rýchla kontrola</h2>' + badge +
        '<span class="result__size">' + esc(st.name) + "</span></div>" +
      '<div class="result__body">' +
        '<div class="stats">' +
          statHTML("chyby", errs.toLocaleString("sk-SK")) +
          statHTML("výhrady", warns.toLocaleString("sk-SK")) +
          statHTML("entity", st.stats.entities.toLocaleString("sk-SK")) +
          statHTML("objekty s GlobalId", s.objects.toLocaleString("sk-SK")) +
          statHTML("triedy", String(s.types)) +
        "</div>" +
        '<div class="chks">' + st.checks.map(checkHTML).join("") + "</div>" +
      "</div>";
  }

  // ---- hĺbková kontrola ----------------------------------------------------
  function renderDeep() {
    var box = $("vlDeep");
    var mb = st.size / (1024 * 1024);
    var head = '<div class="card__head">hĺbková kontrola podľa schémy</div>';

    if (st.deepState === "running") {
      box.innerHTML = head +
        '<div class="deep__body">' +
          '<div class="deep__run"><div class="spinner"></div>' +
            '<div><div class="deep__msg">' + esc(st.deepMsg || "pripravujem…") + "</div>" +
            '<div class="help" id="vlElapsed">beží 0 s</div></div>' +
            '<button class="btn btn--sm btn--ghost" id="vlStop">zrušiť</button>' +
          "</div>" +
        "</div>";
      $("vlStop").addEventListener("click", stopDeep);
      return;
    }

    if (st.deepState === "done" && st.deep) {
      var checks = st.deep;
      var level = worst(checks);
      var badge = level === "ok" ? '<span class="badge badge--ok">bez chýb</span>'
                : '<span class="badge badge--bad">nájdené chyby</span>';
      box.innerHTML =
        '<div class="result__head"><h2>hĺbková kontrola podľa schémy</h2>' + badge +
          '<span class="result__size">' + (st.deepMs / 1000).toFixed(1) + " s</span></div>" +
        '<div class="result__body">' +
          '<div class="chks">' + checks.map(checkHTML).join("") + "</div>" +
          '<div class="dlrow">' +
            '<button class="btn btn--sm btn--ghost" id="vlAgain">spustiť znova</button>' +
            '<span class="mergehint">jadro ifcopenshell.validate — rovnaké ako v službe buildingSMART</span>' +
          "</div>" +
        "</div>";
      $("vlAgain").addEventListener("click", startDeep);
      return;
    }

    box.innerHTML = head +
      '<div class="deep__body">' +
        "<p class=\"help\">Spustí <b>ifcopenshell.validate</b> — to isté jadro, ktoré používa " +
        "validačná služba buildingSMART. Overí dátové typy atribútov, kardinality, " +
        "výčtové hodnoty, SELECT typy a pravidlá WHERE zo schémy EXPRESS.</p>" +
        (st.deepState === "error"
          ? '<div class="note note--bad"><span class="note__i">✕</span><span>' + esc(st.deepMsg) + "</span></div>"
          : "") +
        (mb > BIG_MB
          ? '<div class="note note--warn"><span class="note__i">!</span><span>Súbor má ' +
            Math.round(mb) + " MB. Hĺbková kontrola drží celý model v pamäti prehliadača — " +
            "pri takejto veľkosti môže trvať minúty alebo zlyhať na nedostatok pamäte.</span></div>"
          : "") +
        '<div class="dlrow">' +
          '<button class="btn btn--sm" id="vlRun">spustiť hĺbkovú kontrolu <span class="btn__arr">→</span></button>' +
          '<span class="mergehint">prvé spustenie stiahne ~25 MB knižnice · súbor zostáva vo vašom počítači</span>' +
        "</div>" +
      "</div>";
    $("vlRun").addEventListener("click", startDeep);
  }

  function tick() {
    var el = $("vlElapsed");
    if (el) el.textContent = "beží " + Math.round((Date.now() - st.t0) / 1000) + " s";
  }

  function startDeep() {
    if (!st.file) return;
    st.deepState = "running"; st.deepMsg = "čítam súbor…"; st.deep = null;
    st.t0 = Date.now();
    renderDeep();
    clearInterval(st.timer);
    st.timer = setInterval(tick, 1000);

    var reader = new FileReader();
    reader.onload = function () {
      engine.run(reader.result, function (msg) {
        if (msg.type === "progress") {
          st.deepMsg = msg.text;
          var el = document.querySelector(".deep__msg");
          if (el) el.textContent = msg.text; else renderDeep();
        } else if (msg.type === "result") {
          clearInterval(st.timer);
          st.deepMs = msg.ms;
          st.deep = deepChecks(msg.statements);
          st.deepState = "done";
          renderDeep();
        } else if (msg.type === "error") {
          clearInterval(st.timer);
          if (msg.detail) console.error(msg.detail);
          st.deepState = "error";
          st.deepMsg = "Hĺbková kontrola zlyhala: " + msg.message;
          renderDeep();
        }
      });
    };
    reader.onerror = function () {
      clearInterval(st.timer);
      st.deepState = "error"; st.deepMsg = "Súbor sa nepodarilo prečítať.";
      renderDeep();
    };
    reader.readAsArrayBuffer(st.file);
  }

  function stopDeep() {
    clearInterval(st.timer);
    engine.stop();
    st.deepState = "idle"; st.deepMsg = "";
    renderDeep();
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
      add(c, (who ? who + what + " — " : "") + short, -1, s.message);
    });

    seal(cAttr, "bad", "všetky hodnoty zodpovedajú schéme",
         function (n) { return n.toLocaleString("sk-SK") + " " + plural(n, "chyba", "chyby", "chýb"); });
    seal(cRule, "bad", "žiadne porušené pravidlo",
         function (n) { return n.toLocaleString("sk-SK") + " " + plural(n, "porušenie", "porušenia", "porušení"); });
    return [cAttr, cRule];
  }

  // =========================================================================
  //  Prepojenie na rozhranie
  // =========================================================================
  $("fileC").addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = "";
  });

  window.ValidateTool = {
    syncBar: function () {
      if (!window.AppBar) return;
      AppBar.setStatus(st.idx ? st.name : "kontrola súboru");
      AppBar.setBadge("");
    },
    reset: function () {
      clearInterval(st.timer);
      engine.stop();
      st.file = null; st.name = ""; st.size = 0; st.idx = null;
      st.checks = null; st.stats = null; st.deep = null;
      st.deepState = "idle"; st.deepMsg = "";
      renderDrop("");
    }
  };

  renderDrop("");
})();
