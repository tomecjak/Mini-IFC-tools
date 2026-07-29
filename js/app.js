/* app.js — používateľské rozhranie nástroja na zlúčenie IFC modelov.
 * Rieši načítanie súborov, výber objektov, nastavenia a zobrazenie výsledku.
 * Samotné parsovanie a zlúčenie prebieha v js/ifc-worker.js (jadro js/ifc-merge.js).
 */
(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };

  // ---- výpočtové jadro (Web Worker s núdzovým režimom v hlavnom vlákne) ----
  function makeEngine(){
    var worker = null;
    try{
      worker = new Worker("js/ifc-worker.js");
    }catch(e){ worker = null; }   // napr. pri otvorení stránky cez file://

    var pending = new Map(), seq = 0, store = {};

    // Núdzový režim: tie isté operácie spustené priamo v hlavnom vlákne.
    // Používa sa, keď sa Worker nepodarí vytvoriť alebo spustiť.
    function fallback(msg){
      return new Promise(function(resolve, reject){
        setTimeout(function(){
          try{
            var M = window.IFCMerge;
            if(msg.type === "parse"){
              var model = M.parseIFC(msg.text); store[msg.slot] = model;
              resolve({ok:true, summary:{
                schema:model.schema, lengthUnit:model.lengthUnit,
                entityCount:model.entities.size, maxId:model.maxId,
                containers:M.spatialContainers(model), breakdown:M.typeBreakdown(model),
                objects:M.importableObjects(model)
              }});
            } else if(msg.type === "merge"){
              var A = store.A, B = store.B;
              if(!A || !B) throw new Error("Modely nie sú načítané.");
              var res = M.mergeParsed(A, B, msg.options);
              resolve({ok:true, ifc:res.ifc, report:res.report, validation:M.validate(res.ifc)});
            }
          }catch(e){ reject(e); }
        }, 20);
      });
    }

    if(worker){
      worker.onmessage = function(ev){
        var d = ev.data, p = pending.get(d.id);
        if(!p) return; pending.delete(d.id);
        d.ok ? p.resolve(d) : p.reject(new Error(d.error));
      };
      worker.onerror = function(e){
        // Worker sa nepodarilo spustiť — prepneme sa na hlavné vlákno
        // a všetky čakajúce požiadavky spustíme znova.
        if(e && e.preventDefault) e.preventDefault();
        worker = null;
        var waiting = Array.from(pending.values());
        pending.clear();
        waiting.forEach(function(p){ fallback(p.msg).then(p.resolve, p.reject); });
      };
    }

    function req(msg){
      if(worker){
        return new Promise(function(resolve, reject){
          var id = ++seq;
          pending.set(id, {resolve:resolve, reject:reject, msg:msg});
          worker.postMessage(Object.assign({id:id}, msg));
        });
      }
      return fallback(msg);
    }
    return {
      parse: function(slot, text){ return req({type:"parse", slot:slot, text:text}); },
      merge: function(options){ return req({type:"merge", options:options}); }
    };
  }
  var engine = makeEngine();

  // ---- stav ---------------------------------------------------------------
  var state = { A:null, B:null };      // súhrny z parsovania + názov súboru
  var selected = new Set();            // ID objektov sekundárneho modelu na import
  var lastResult = null;

  var TYPE_SK = {
    IFCBUILDINGSTOREY:"Podlažie", IFCBUILDING:"Budova", IFCSITE:"Areál",
    IFCSPACE:"Priestor", IFCSPATIALZONE:"Zóna"
  };
  function containerLabel(t){ return TYPE_SK[t] || pretty(t); }
  function pretty(t){ return t.replace(/^IFC/,""); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c];}); }

  var UPLOAD_ICON = '<svg class="drop__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4m0 0L7 9m5-5l5 5"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/></svg>';

  // ---- zóny na pretiahnutie súborov ---------------------------------------
  function renderDrop(slot, errorMsg){
    var body = $(slot==="A"?"bodyA":"bodyB");
    body.innerHTML =
      '<div class="drop" data-slot="'+slot+'">'+
        UPLOAD_ICON+
        '<div class="drop__main">Presuňte sem IFC súbor</div>'+
        '<div class="drop__hint">alebo kliknite pre výber · formát <b>.ifc</b></div>'+
        (errorMsg?'<div class="errline">'+esc(errorMsg)+'</div>':'')+
      '</div>';
    var dz = body.querySelector(".drop");
    dz.addEventListener("click", function(){ $(slot==="A"?"fileA":"fileB").click(); });
    dz.addEventListener("dragover", function(e){ e.preventDefault(); dz.classList.add("is-over"); });
    dz.addEventListener("dragleave", function(){ dz.classList.remove("is-over"); });
    dz.addEventListener("drop", function(e){
      e.preventDefault(); dz.classList.remove("is-over");
      if(e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(slot, e.dataTransfer.files[0]);
    });
  }

  function handleFile(slot, file){
    var body = $(slot==="A"?"bodyA":"bodyB");
    body.innerHTML = '<div class="drop"><div class="spinner" style="border-color:rgba(0,0,0,.15);border-top-color:'+(slot==="A"?"#0E5A8A":"#B45309")+'"></div><div class="drop__main" style="margin-top:10px">Analyzujem '+esc(file.name)+'…</div></div>';
    var reader = new FileReader();
    reader.onload = function(){
      engine.parse(slot, reader.result).then(function(res){
        state[slot] = { name:file.name, summary:res.summary };
        if(slot==="A") renderSummaryA(); else { initSelection(res.summary); renderSummaryB(); }
        syncSettings();
      }).catch(function(err){
        state[slot] = null;
        renderDrop(slot, "Súbor sa nepodarilo načítať: " + err.message);
        syncSettings();
      });
    };
    reader.onerror = function(){ renderDrop(slot, "Chyba pri čítaní súboru."); };
    reader.readAsText(file);
  }

  // ---- súhrny načítaných modelov ------------------------------------------
  function unitChip(u){
    var known = {mm:"mm", cm:"cm", dm:"dm", m:"m", km:"km"};
    return known[u] ? '<span class="chip">jednotka <b>'+u+'</b></span>'
                    : '<span class="chip chip--warn">jednotka neurčená</span>';
  }
  function summaryChips(s){
    return '<div class="chiprow">'+
      '<span class="chip">schéma <b>'+esc(s.schema)+'</b></span>'+
      unitChip(s.lengthUnit)+
      '<span class="chip"><b>'+s.entityCount.toLocaleString("sk-SK")+'</b> entít</span>'+
    '</div>';
  }
  function breakdownHTML(s){
    var rows = s.breakdown.slice(0,60).map(function(b){
      return '<div class="t">'+esc(pretty(b.type))+'</div><div class="c">'+b.count+'</div>';
    }).join("");
    return '<details class="breakdown"><summary>Zloženie modelu ('+s.breakdown.length+' typov)</summary><div class="bd-grid">'+rows+'</div></details>';
  }
  function fileLine(slot){
    var st = state[slot];
    return '<div class="file-line"><span class="name">'+esc(st.name)+'</span>'+
           '<button class="linkbtn" data-change="'+slot+'">zmeniť</button></div>';
  }

  function renderSummaryA(){
    var s = state.A.summary;
    $("subA").textContent = "#…"+s.maxId;
    $("bodyA").innerHTML =
      '<div class="summary">'+ fileLine("A") + summaryChips(s) + breakdownHTML(s) +'</div>';
    wireChange();
  }

  function renderSummaryB(){
    var s = state.B.summary;
    $("subB").textContent = "#…"+s.maxId;
    var total = s.objects.reduce(function(n,g){return n+g.items.length;},0);
    var html = '<div class="summary">'+ fileLine("B") + summaryChips(s);
    if(total === 0){
      html += '<div class="errline">V tomto modeli sa nenašli žiadne objekty zaradené v priestorovej štruktúre (IfcRelContainedInSpatialStructure). Nie je čo importovať.</div>';
    } else {
      html += '<div class="objsel">'+
        '<div class="objsel__bar">'+
          '<span class="objsel__count" id="selCount"></span>'+
          '<button class="linkbtn" data-selall="1">Vybrať všetko</button>'+
          '<button class="linkbtn" data-selnone="1">Zrušiť výber</button>'+
        '</div>'+
        '<div class="objsel__list" id="objList">'+ objTreeHTML(s.objects) +'</div>'+
      '</div>';
    }
    html += '</div>';
    $("bodyB").innerHTML = html;
    wireChange();
    if(total>0){ wireSelection(); syncSelectionUI(); }
  }

  function objTreeHTML(groups){
    return groups.map(function(g){
      var items = g.items.map(function(it){
        return '<label class="item"><input type="checkbox" class="item-cb" data-id="'+it.id+'"'+(selected.has(it.id)?' checked':'')+'>'+
               '<span class="nm">'+esc(it.name || "(bez názvu)")+'</span>'+
               (it.guid?'<span class="gid">'+esc(it.guid)+'</span>':'')+'</label>';
      }).join("");
      return '<div class="grp" data-type="'+esc(g.type)+'">'+
        '<div class="grp__head">'+
          '<input type="checkbox" class="grp-cb" data-type="'+esc(g.type)+'">'+
          '<svg class="grp__caret" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l4 4-4 4z"/></svg>'+
          '<span class="grp__type">'+esc(pretty(g.type))+'</span>'+
          '<span class="grp__n">'+g.items.length+'</span>'+
        '</div>'+
        '<div class="grp__items">'+items+'</div>'+
      '</div>';
    }).join("");
  }

  // ---- výber objektov -----------------------------------------------------
  function initSelection(summary){
    selected = new Set();
    summary.objects.forEach(function(g){ g.items.forEach(function(it){ selected.add(it.id); }); });
  }
  function wireSelection(){
    var list = $("objList");
    list.addEventListener("change", function(e){
      var t = e.target;
      if(t.classList.contains("item-cb")){
        var id = +t.getAttribute("data-id");
        t.checked ? selected.add(id) : selected.delete(id);
        syncSelectionUI();
      } else if(t.classList.contains("grp-cb")){
        var type = t.getAttribute("data-type");
        var g = state.B.summary.objects.find(function(x){return x.type===type;});
        g.items.forEach(function(it){ t.checked ? selected.add(it.id) : selected.delete(it.id); });
        syncSelectionUI();
      }
    });
    list.addEventListener("click", function(e){
      var head = e.target.closest(".grp__head");
      if(head && !e.target.closest(".grp-cb")) head.parentElement.classList.toggle("open");
    });
    $("bodyB").querySelector("[data-selall]").addEventListener("click", function(){ setAll(true); });
    $("bodyB").querySelector("[data-selnone]").addEventListener("click", function(){ setAll(false); });
  }
  function setAll(on){
    selected = new Set();
    if(on) state.B.summary.objects.forEach(function(g){ g.items.forEach(function(it){ selected.add(it.id); }); });
    // premietnuť do zaškrtávacích políčok jednotlivých položiek
    $("objList").querySelectorAll(".item-cb").forEach(function(cb){ cb.checked = on; });
    syncSelectionUI();
  }
  function syncSelectionUI(){
    var list = $("objList");
    // udržať každé políčko položky v súlade so sadou vybratých ID
    list.querySelectorAll(".item-cb").forEach(function(cb){
      cb.checked = selected.has(+cb.getAttribute("data-id"));
    });
    var groups = state.B.summary.objects;
    groups.forEach(function(g){
      var cb = list.querySelector('.grp-cb[data-type="'+cssEsc(g.type)+'"]');
      if(!cb) return;
      var sel = g.items.filter(function(it){return selected.has(it.id);}).length;
      cb.checked = sel === g.items.length && sel>0;
      cb.indeterminate = sel>0 && sel<g.items.length;
    });
    var total = groups.reduce(function(n,g){return n+g.items.length;},0);
    var c = $("selCount"); if(c) c.textContent = "Vybraté: " + selected.size + " / " + total;
    updateMergeBtn();
  }
  function cssEsc(s){ return s.replace(/"/g,'\\"'); }

  function wireChange(){
    document.querySelectorAll("[data-change]").forEach(function(b){
      b.addEventListener("click", function(){
        var slot = b.getAttribute("data-change");
        state[slot] = null;
        if(slot==="B") selected = new Set();
        renderDrop(slot); syncSettings();
      });
    });
  }

  // ---- nastavenia ---------------------------------------------------------
  function syncSettings(){
    var ready = state.A && state.B;
    $("settings").hidden = !ready;
    if(ready){
      // možnosti cieľového kontajnera
      var sel = $("target"); sel.innerHTML = "";
      state.A.summary.containers.forEach(function(c){
        var o = document.createElement("option");
        o.value = c.id;
        o.textContent = containerLabel(c.type) + " · " + (c.name || "(bez názvu)") + "  #" + c.id;
        sel.appendChild(o);
      });
      // poznámka o jednotke posunu
      var u = state.A.summary.lengthUnit;
      $("offHelp").textContent = "V jednotkách primárneho modelu" + (u&&u!=="?"?(" ("+u+")"):"") + ". Pridá sa k polohe každého importovaného objektu.";
      // zoznam typov primárneho modelu, ktoré sa dajú odstrániť
      var grid = $("pruneGrid");
      var pobjs = state.A.summary.objects;
      if(pobjs.length===0){
        grid.innerHTML = '<div class="help">Primárny model neobsahuje samostatné objekty na odstránenie.</div>';
      } else {
        grid.innerHTML = pobjs.map(function(g){
          return '<label class="typeopt"><input type="checkbox" class="prune-cb" data-type="'+esc(g.type)+'">'+
                 '<span class="tn">'+esc(pretty(g.type))+'</span><span class="tc">'+g.items.length+'</span></label>';
        }).join("");
      }
    }
    updateMergeBtn();
  }

  function updateMergeBtn(){
    var btn = $("mergeBtn"), hint = $("mergeHint");
    var ready = state.A && state.B;
    if(!ready){ btn.disabled = true; hint.textContent = state.A ? "Načítajte sekundárny model." : (state.B ? "Načítajte primárny model." : "Načítajte oba modely."); return; }
    if(selected.size === 0){ btn.disabled = true; hint.textContent = "Vyberte aspoň jeden objekt na import."; return; }
    btn.disabled = false;
    hint.textContent = "Pridá sa " + selected.size + " objekt(ov) do primárneho modelu.";
  }

  // ---- zlúčenie -----------------------------------------------------------
  $("mergeBtn").addEventListener("click", function(){
    var btn = $("mergeBtn");
    var pmode = document.querySelector('input[name="pmode"]:checked').value;
    var pruneTypes = Array.prototype.map.call(document.querySelectorAll(".prune-cb:checked"),
      function(cb){ return cb.getAttribute("data-type"); });
    var opts = {
      importIds: Array.from(selected),
      targetContainerId: +$("target").value,
      placementMode: pmode,
      offset: { x:parseFloat($("offX").value)||0, y:parseFloat($("offY").value)||0, z:parseFloat($("offZ").value)||0 },
      copyProperties: $("copyProps").checked,
      copyMaterials: $("copyMats").checked,
      primaryExcludeTypes: pruneTypes
    };
    btn.disabled = true;
    var orig = btn.textContent; btn.innerHTML = '<span class="spinner"></span> Zlučujem…';
    $("mergeHint").textContent = "";
    engine.merge(opts).then(function(res){
      lastResult = res;
      renderResult(res);
      btn.disabled = false; btn.textContent = orig;
      updateMergeBtn();
      $("result").scrollIntoView({behavior:"smooth", block:"start"});
    }).catch(function(err){
      btn.disabled = false; btn.textContent = orig;
      $("result").hidden = false;
      $("result").innerHTML = '<div class="result__head"><h2>Chyba</h2><span class="badge badge--bad">zlyhalo</span></div>'+
        '<div class="result__body"><div class="errline">Zlúčenie zlyhalo: '+esc(err.message)+'</div></div>';
    });
  });

  function statHTML(k, v, vs){
    return '<div class="stat"><div class="k">'+esc(k)+'</div>'+
           (v!=null?'<div class="v">'+esc(v)+'</div>':'')+
           (vs?'<div class="vs">'+esc(vs)+'</div>':'')+'</div>';
  }

  function renderResult(res){
    var r = res.report, v = res.validation;
    var el = $("result"); el.hidden = false;

    var warns = (r.warnings||[]).length
      ? '<div class="warnbox"><b>Upozornenia</b>'+ r.warnings.map(function(w){return '<div>'+esc(w)+'</div>';}).join("") +'</div>'
      : '';

    var stats = '<div class="stats">'+
      statHTML("Importované objekty", r.importedProducts) +
      statHTML("Skopírované entity", r.copiedEntities) +
      statHTML("Nové väzby", r.copiedRelationships) +
      statHTML("Entít vo výstupe", (r.totalEntitiesOut||0).toLocaleString("sk-SK")) +
      statHTML("Cieľový kontajner", null, r.targetContainer) +
      (r.droppedFromPrimary ? statHTML("Odstránené z primárneho", r.droppedFromPrimary) : "") +
    '</div>';

    var valid = v.ok
      ? '<div class="valid ok">✓ Súbor je konzistentný — žiadne visiace referencie, žiadne duplicitné ID, práve jeden IFCPROJECT. Entít: '+v.count.toLocaleString("sk-SK")+'.</div>'
      : '<div class="valid bad"><div>⚠ Nájdené problémy ('+v.problems.length+'):</div><ul>'+
          v.problems.slice(0,15).map(function(p){return '<li>'+esc(p)+'</li>';}).join("")+
          (v.problems.length>15?'<li>… a ďalšie</li>':'')+'</ul></div>';

    var sizeKB = lastResult ? Math.round(new Blob([lastResult.ifc]).size/1024) : 0;
    var dl = '<div class="dlrow">'+
      '<button class="btn btn--ghost" id="dlBtn">Stiahnuť IFC ('+sizeKB.toLocaleString("sk-SK")+' kB)</button>'+
      '<span class="mergehint">Overte výsledok vo svojom BIM prehliadači.</span>'+
    '</div>';

    el.innerHTML =
      '<div class="result__head"><h2>Výsledok zlúčenia</h2>'+
        (v.ok?'<span class="badge badge--ok">konzistentné</span>':'<span class="badge badge--bad">skontrolujte</span>')+
      '</div>'+
      '<div class="result__body">'+ warns + stats + valid + dl +'</div>';

    $("dlBtn").addEventListener("click", downloadResult);
  }

  function downloadResult(){
    if(!lastResult) return;
    var base = (state.A && state.A.name || "model").replace(/\.[^.]+$/,"");
    var blob = new Blob([lastResult.ifc], {type:"application/octet-stream"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = base + "_zluceny.ifc";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  // ---- skryté vstupy na výber súborov -------------------------------------
  $("fileA").addEventListener("change", function(e){ if(e.target.files[0]) handleFile("A", e.target.files[0]); e.target.value=""; });
  $("fileB").addEventListener("change", function(e){ if(e.target.files[0]) handleFile("B", e.target.files[0]); e.target.value=""; });

  // ---- inicializácia ------------------------------------------------------
  renderDrop("A");
  renderDrop("B");
})();
