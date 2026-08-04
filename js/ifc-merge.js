/* ifc-merge.js — výpočtové jadro na zlúčenie IFC modelov (STEP / ISO-10303-21)
 * napísané v čistom JavaScripte. Funguje v Node aj v prehliadači (bez závislostí).
 *
 * Postup: PRIMÁRNY model zostáva celý (voliteľne sa z neho odstránia niektoré
 * typy), zo SEKUNDÁRNEHO sa skopírujú len VYBRANÉ produktové entity spolu s ich
 * závislosťami (geometria, umiestnenie, materiály, property sety). Skopírované
 * entity sa prečíslujú, aby nedošlo ku kolízii ID, spoločné zdroje (reprezentačný
 * kontext, owner history) sa prelinkujú na entity primárneho modelu a objekty sa
 * zaradia do zvoleného priestorového kontajnera primárneho modelu.
 */
(function (root) {
  "use strict";

  // ---- Priestorové a spoločné typy, ktoré zo sekundárneho nikdy nekopírujeme ----
  // (buď už v primárnom existujú, alebo väzby na ne vytvárame nanovo)
  const SPATIAL_TYPES = new Set([
    "IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE",
    "IFCSPATIALZONE", "IFCEXTERNALSPATIALELEMENT"
  ]);
  const SHARED_RESOURCE_TYPES = new Set([
    "IFCGEOMETRICREPRESENTATIONCONTEXT", "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
    "IFCUNITASSIGNMENT"
  ]);
  // Vzťahové (relationship) triedy nikdy nekopírujeme naslepo — prechádzame ich zvlášť.
  const REL_PREFIX = "IFCREL";

  // Typy kontajnerov umiestnenia / reprezentácie (priestorová štruktúra, do ktorej
  // fyzické produkty patria) — slúžia na rozpoznanie „samostatných objektov“.
  const NON_OBJECT_TYPES = new Set([
    ...SPATIAL_TYPES,
    "IFCOPENINGELEMENT", "IFCVOIDINGFEATURE"
  ]);

  // ---------------------------------------------------------------------------
  // Pomocné funkcie tokenizéra
  // ---------------------------------------------------------------------------

  // Vráti jednotlivé príkazy sekcie DATA (bez koncovej bodkočiarky) so správnym
  // spracovaním reťazcových literálov a komentárov /* */.
  function splitStatements(dataText) {
    const out = [];
    let buf = "";
    let inStr = false;
    for (let i = 0; i < dataText.length; i++) {
      const c = dataText[i];
      if (inStr) {
        buf += c;
        if (c === "'") {
          if (dataText[i + 1] === "'") { buf += "'"; i++; } // escapovaný apostrof
          else inStr = false;
        }
        continue;
      }
      if (c === "'") { inStr = true; buf += c; continue; }
      if (c === "/" && dataText[i + 1] === "*") { // preskočiť komentár
        i += 2;
        while (i < dataText.length && !(dataText[i] === "*" && dataText[i + 1] === "/")) i++;
        i++; // zastavíme sa na '/'
        continue;
      }
      if (c === ";") { const s = buf.trim(); if (s) out.push(s); buf = ""; continue; }
      buf += c;
    }
    const tail = buf.trim();
    if (tail) out.push(tail);
    return out;
  }

  // Zamaskuje reťazcové literály, aby sa dalo hľadať #odkazy a deliť argumenty
  // bez zásahu do znakov vnútri reťazcov. Vracia rovnako dlhý reťazec, v ktorom
  // je každý znak vnútri '...' nahradený medzerou.
  function maskStrings(s) {
    let res = "";
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === "'") {
          if (s[i + 1] === "'") { res += "  "; i++; }
          else { res += "'"; inStr = false; }
        } else res += " ";
        continue;
      }
      if (c === "'") { inStr = true; res += "'"; continue; }
      res += c;
    }
    return res;
  }

  // Všetky odkazy na entity (#123) v reťazci argumentov; odkazy vnútri
  // reťazcových literálov sa ignorujú.
  function refsIn(argStr) {
    const masked = maskStrings(argStr);
    const ids = [];
    const re = /#(\d+)/g;
    let m;
    while ((m = re.exec(masked))) ids.push(+m[1]);
    return ids;
  }

  // Rozdelí argumenty na najvyššej úrovni v tele typu TYPE(a,b,(c,d),#e).
  // Vracia pole orezaných argumentov NAJVRCHNEJŠEJ zátvorkovej skupiny.
  function topLevelArgs(body) {
    const masked = maskStrings(body);
    const open = masked.indexOf("(");
    if (open < 0) return [];
    // nájsť zátvorku uzatvárajúcu prvú '('
    let depth = 0, end = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return [];
    const inner = body.slice(open + 1, end);
    const innerMask = masked.slice(open + 1, end);
    const args = [];
    let start = 0, d = 0;
    for (let i = 0; i < innerMask.length; i++) {
      const ch = innerMask[i];
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if (ch === "," && d === 0) { args.push(inner.slice(start, i).trim()); start = i + 1; }
    }
    args.push(inner.slice(start).trim());
    return args;
  }

  // Rozdelí surový reťazec podľa čiarok na najvyššej úrovni (hĺbka 0),
  // s ohľadom na reťazcové literály.
  function splitTopLevel(str) {
    const masked = maskStrings(str);
    const parts = [];
    let start = 0, d = 0;
    for (let i = 0; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if (ch === "," && d === 0) { parts.push(str.slice(start, i)); start = i + 1; }
    }
    parts.push(str.slice(start));
    return parts;
  }

  // Odstráni z tela entity odkazy na ID zo sady `dropped`. Zoznamy sa vyčistia
  // (položka sa vymaže), nie vynulujú. Vracia {body, emptiedList, scalarDropped}.
  function cleanBodyRemovingRefs(body, dropped) {
    const masked = maskStrings(body);
    const open = masked.indexOf("(");
    if (open < 0) return { body, emptiedList: false, scalarDropped: false };
    const type = body.slice(0, open);
    // uzatváracia zátvorka najvrchnejšej skupiny
    let depth = 0, end = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    const args = splitTopLevel(body.slice(open + 1, end));
    let emptiedList = false, scalarDropped = false;

    function cleanArg(arg) {
      const t = arg.trim();
      if (t[0] === "(") {
        const innerRaw = t.slice(1, -1);
        const wasEmpty = innerRaw.trim() === "";
        const items = splitTopLevel(innerRaw).map(x => x.trim()).filter(x => x !== "");
        const kept = [];
        for (let it of items) {
          const rm = /^#(\d+)$/.exec(it);
          if (rm && dropped.has(+rm[1])) continue;
          if (it[0] === "(") it = cleanArg(it);
          kept.push(it);
        }
        if (!wasEmpty && kept.length === 0) emptiedList = true;
        return "(" + kept.join(",") + ")";
      }
      const rm = /^#(\d+)$/.exec(t);
      if (rm && dropped.has(+rm[1])) { scalarDropped = true; return "$"; }
      return arg;
    }

    const cleaned = args.map(cleanArg);
    return { body: `${type}(${cleaned.join(",")})`, emptiedList, scalarDropped };
  }

  // ---------------------------------------------------------------------------
  // Parsovanie
  // ---------------------------------------------------------------------------

  function parseIFC(text) {
    const dataStart = text.indexOf("DATA;");
    const dataEnd = text.indexOf("ENDSEC;", dataStart < 0 ? 0 : dataStart);
    if (dataStart < 0 || dataEnd < 0) throw new Error("Neplatný IFC súbor: chýba sekcia DATA.");
    const header = text.slice(0, dataStart + "DATA;".length);
    const dataText = text.slice(dataStart + "DATA;".length, dataEnd);

    // zistenie schémy a dĺžkovej jednotky z hlavičky
    let schema = "UNKNOWN";
    const sm = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
    if (sm) schema = sm[1].toUpperCase();

    const entities = new Map(); // id -> {id, type, body}
    const order = [];
    let maxId = 0;
    for (const stmt of splitStatements(dataText)) {
      const eq = stmt.indexOf("=");
      if (stmt[0] !== "#" || eq < 0) continue;
      const id = parseInt(stmt.slice(1, eq).trim(), 10);
      if (!Number.isFinite(id)) continue;
      const body = stmt.slice(eq + 1).trim(); // napr. IFCWALL(...)
      const tm = body.match(/^([A-Za-z0-9_]+)/);
      const type = tm ? tm[1].toUpperCase() : "";
      entities.set(id, { id, type, body });
      order.push(id);
      if (id > maxId) maxId = id;
    }

    const lengthUnit = sniffLengthUnit(entities);
    return { header, schema, entities, order, maxId, lengthUnit, raw: text };
  }

  function sniffLengthUnit(entities) {
    // Hľadáme IFCSIUNIT(*,.LENGTHUNIT.,<predpona>,.METRE.)
    for (const e of entities.values()) {
      if (e.type !== "IFCSIUNIT") continue;
      const a = topLevelArgs(e.body);
      // argumenty: Dimensions (*), UnitType, Prefix, Name
      if (a.some(x => /\.LENGTHUNIT\./i.test(x))) {
        const prefix = a.find(x => /MILLI|CENTI|DECI|KILO/i.test(x));
        if (prefix) {
          if (/MILLI/i.test(prefix)) return "mm";
          if (/CENTI/i.test(prefix)) return "cm";
          if (/DECI/i.test(prefix)) return "dm";
          if (/KILO/i.test(prefix)) return "km";
        }
        return "m";
      }
    }
    return "?";
  }

  // ---------------------------------------------------------------------------
  // Introspekcia pre používateľské rozhranie
  // ---------------------------------------------------------------------------

  // Čo najlepší pokus o získanie atribútu Name produktu.
  function productName(ent) {
    const a = topLevelArgs(ent.body);
    // Korene (IfcRoot): GlobalId, OwnerHistory, Name, Description, ...
    const nm = a[2];
    if (nm && nm !== "$") return unquote(nm);
    return "";
  }
  function globalId(ent) {
    const a = topLevelArgs(ent.body);
    return a[0] ? unquote(a[0]) : "";
  }
  function unquote(s) {
    if (!s) return "";
    s = s.trim();
    if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
    return s;
  }

  // Každá entita, ktorá (heuristicky) dedí z IfcProduct a je fyzickým objektom,
  // nie priestorovou štruktúrou. Bez EXPRESS modelu nevieme vyhodnotiť úplnú
  // dedičnosť schémy, preto používame pragmatické pravidlo: čokoľvek, na čo sa
  // odkazuje RelatedElement vo vzťahu IfcRelContainedInSpatialStructure, je
  // fyzický produkt zaradený v priestorovej štruktúre.
  function collectContainedProducts(model) {
    const contained = new Set();
    for (const e of model.entities.values()) {
      if (e.type === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
        const a = topLevelArgs(e.body);
        // argumenty: GlobalId, OwnerHistory, Name, Description, RelatedElements (zoznam), RelatingStructure
        const listArg = a[4] || "";
        for (const id of refsIn(listArg)) contained.add(id);
      }
    }
    return contained;
  }

  // Zoskupí importovateľné objekty podľa typu spolu s jednotlivými položkami.
  function importableObjects(model) {
    const contained = collectContainedProducts(model);
    const groups = new Map(); // typ -> [{id,name,guid}]
    for (const id of contained) {
      const e = model.entities.get(id);
      if (!e) continue;
      if (NON_OBJECT_TYPES.has(e.type)) continue;
      if (!groups.has(e.type)) groups.set(e.type, []);
      groups.get(e.type).push({ id, name: productName(e), guid: globalId(e) });
    }
    // zoradenie
    const result = [...groups.entries()]
      .map(([type, items]) => ({ type, items: items.sort((x, y) => x.id - y.id) }))
      .sort((a, b) => a.type.localeCompare(b.type));
    return result;
  }

  // Zloženie celého modelu podľa typov (pre panel primárneho modelu).
  function typeBreakdown(model) {
    const counts = new Map();
    for (const e of model.entities.values()) {
      counts.set(e.type, (counts.get(e.type) || 0) + 1);
    }
    return [...counts.entries()].map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }

  // Priestorové kontajnery primárneho modelu, do ktorých môže používateľ objekty vložiť.
  function spatialContainers(model) {
    const out = [];
    for (const e of model.entities.values()) {
      if (SPATIAL_TYPES.has(e.type) && e.type !== "IFCPROJECT") {
        out.push({ id: e.id, type: e.type, name: productName(e) || globalId(e) });
      }
    }
    // najprv podlažia, potom budovy, potom areály
    const rank = t => (t === "IFCBUILDINGSTOREY" ? 0 : t === "IFCBUILDING" ? 1 : t === "IFCSITE" ? 2 : 3);
    return out.sort((a, b) => rank(a.type) - rank(b.type) || a.id - b.id);
  }

  // ---------------------------------------------------------------------------
  // Vyhľadanie spoločných zdrojov v primárnom modeli
  // ---------------------------------------------------------------------------

  function findPrimaryOwnerHistory(model) {
    for (const e of model.entities.values())
      if (e.type === "IFCOWNERHISTORY") return e.id;
    return null;
  }

  // Uprednostníme hlavný 3D kontext „Model“ (IfcGeometricRepresentationContext).
  function findPrimaryModelContext(model) {
    let fallback = null;
    for (const e of model.entities.values()) {
      if (e.type === "IFCGEOMETRICREPRESENTATIONCONTEXT") {
        const a = topLevelArgs(e.body);
        // argumenty: ContextIdentifier, ContextType, CoordinateSpaceDimension, Precision, WorldCoordinateSystem, TrueNorth
        const ctxType = unquote(a[1] || "");
        if (/model/i.test(ctxType) || (a[2] && a[2].indexOf("3") >= 0)) return e.id;
        if (fallback == null) fallback = e.id;
      }
    }
    return fallback;
  }

  function objectPlacementOf(ent) {
    // Produkty: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag
    const a = topLevelArgs(ent.body);
    const pl = a[5];
    if (pl && pl[0] === "#") return parseInt(pl.slice(1), 10);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Generovanie GUID (komprimovaný 22-znakový IFC formát)
  // ---------------------------------------------------------------------------
  const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  function to64(num, len) {
    let s = "";
    for (let i = 0; i < len; i++) { s = B64[num & 0x3f] + s; num = Math.floor(num / 64); }
    return s;
  }
  function newIfcGuid() {
    let hex;
    if (typeof crypto !== "undefined" && crypto.randomUUID) hex = crypto.randomUUID().replace(/-/g, "");
    else hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const b = [];
    for (let i = 0; i < 16; i++) b.push(parseInt(hex.substr(i * 2, 2), 16));
    return to64(b[0], 2)
      + to64((b[1] << 16) | (b[2] << 8) | b[3], 4)
      + to64((b[4] << 16) | (b[5] << 8) | b[6], 4)
      + to64((b[7] << 16) | (b[8] << 8) | b[9], 4)
      + to64((b[10] << 16) | (b[11] << 8) | b[12], 4)
      + to64((b[13] << 16) | (b[14] << 8) | b[15], 4);
  }

  // ---------------------------------------------------------------------------
  // Prepis odkazov
  // ---------------------------------------------------------------------------

  // Prepíše každý #odkaz v tele entity pomocou mapFn(pôvodnéId) -> novéId (číslo),
  // '$' (odkaz sa vynuluje) alebo to isté číslo (odkaz zostane). Reťazce ostávajú nedotknuté.
  function rewriteBody(body, mapFn) {
    let out = "";
    let inStr = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        out += c;
        if (c === "'") {
          if (body[i + 1] === "'") { out += "'"; i++; }
          else inStr = false;
        }
        continue;
      }
      if (c === "'") { inStr = true; out += c; continue; }
      if (c === "#") {
        let j = i + 1, num = "";
        while (j < body.length && body[j] >= "0" && body[j] <= "9") { num += body[j]; j++; }
        if (num) {
          const mapped = mapFn(+num);
          if (mapped === "$" || mapped === null) out += "$";
          else out += "#" + mapped;
          i = j - 1;
          continue;
        }
      }
      out += c;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Uzáver závislostí
  // ---------------------------------------------------------------------------

  // Pre počiatočné (seed) ID produktov v sekundárnom modeli nájde všetky entity,
  // ktoré treba skopírovať.
  // stopTypes: typy, do ktorých nevstupujeme a ktoré nekopírujeme (priestorové
  //   a spoločné zdroje).
  // opts.cutPlacementRelTo: sada ID entít IfcLocalPlacement, pri ktorých sa
  //   ignoruje hrana PlacementRelTo (režim zarovnania na cieľový kontajner).
  function computeClosure(model, seeds, opts) {
    const stopTypes = new Set([...SPATIAL_TYPES, ...SHARED_RESOURCE_TYPES, "IFCOWNERHISTORY"]);
    const keep = new Set();
    const stack = [];
    const cut = opts.cutPlacementRelTo || new Set();

    for (const s of seeds) if (model.entities.has(s)) { keep.add(s); stack.push(s); }

    while (stack.length) {
      const id = stack.pop();
      const e = model.entities.get(id);
      if (!e) continue;
      let refs;
      if (e.type === "IFCLOCALPLACEMENT" && cut.has(id)) {
        // sledujeme len RelativePlacement (2. argument), PlacementRelTo (1.) vynechávame
        const a = topLevelArgs(e.body);
        refs = a.length >= 2 ? refsIn(a[1]) : refsIn(e.body);
      } else {
        refs = refsIn(e.body);
      }
      for (const r of refs) {
        if (keep.has(r)) continue;
        const re = model.entities.get(r);
        if (!re) continue;                    // visiaci odkaz v zdroji; preskočiť
        if (stopTypes.has(re.type)) continue; // hranica: prelinkuje sa neskôr, nekopíruje sa
        if (re.type.startsWith(REL_PREFIX)) continue; // vzťahy riešime samostatne
        keep.add(r);
        stack.push(r);
      }
    }
    return keep;
  }

  // Nájde IfcStyledItem entity zo sekundárneho modelu, ktoré priraďujú farbu/štýl
  // priamo geometrickej položke (nie cez materiál) — IfcStyledItem odkazuje na
  // svoju položku dopredu (Item), takže bez tohto kroku ho uzáver závislostí
  // produktu nikdy nenájde (nič v skopírovanom grafe naň spätne neodkazuje).
  // Vráti pole ID týchto IfcStyledItem entít, z ktorých sa dá uzáver rozšíriť
  // (dotiahne sa tak IfcSurfaceStyle/IfcColourRgb a pod.).
  function collectStyledItemSeeds(model, keptIds) {
    const seeds = [];
    for (const e of model.entities.values()) {
      if (e.type !== "IFCSTYLEDITEM") continue;
      const a = topLevelArgs(e.body);
      const m = /^#(\d+)$/.exec((a[0] || "").trim());
      if (m && keptIds.has(+m[1])) seeds.push(e.id);
    }
    return seeds;
  }

  // Nájde v sekundárnom modeli vzťahy, ktoré k importovaným objektom pripájajú
  // property sety / materiály / typy, a vráti {rels:[{ent, keptRelated:[ids]}], defClosure:Set},
  // kde defClosure je doplnkový uzáver definícií na skopírovanie (psety, materiály, typy).
  function collectDefinitionRels(model, importedSet, opts) {
    const wanted = new Set([
      "IFCRELDEFINESBYPROPERTIES",
      "IFCRELDEFINESBYTYPE",
      "IFCRELASSOCIATESMATERIAL",
      "IFCRELASSOCIATESCLASSIFICATION"
    ]);
    const rels = [];
    const defSeeds = [];
    for (const e of model.entities.values()) {
      if (!wanted.has(e.type)) continue;
      const a = topLevelArgs(e.body);
      // Tvar vzťahu sa líši; RelatedObjects je vždy zoznam objektov.
      // IfcRelDefinesByProperties: (GlobalId,Owner,Name,Desc,RelatedObjects,RelatingPropertyDefinition)
      // IfcRelDefinesByType:       (...,RelatedObjects,RelatingType)
      // IfcRelAssociates*:         (GlobalId,Owner,Name,Desc,RelatedObjects,Relating*)
      let relatedArgIdx = 4, relatingArgIdx = 5;
      const relatedIds = refsIn(a[relatedArgIdx] || "").filter(id => importedSet.has(id));
      if (!relatedIds.length) continue;
      const relatingIds = refsIn(a[relatingArgIdx] || "");
      rels.push({ ent: e, keptRelated: relatedIds, relatingIdx: relatingArgIdx, relatedIdx: relatedArgIdx });
      for (const rid of relatingIds) defSeeds.push(rid);
    }
    const defClosure = computeClosure(model, defSeeds, { cutPlacementRelTo: new Set() });
    return { rels, defClosure };
  }

  // ---------------------------------------------------------------------------
  // Zlúčenie
  // ---------------------------------------------------------------------------

  function mergeParsed(A, B, options) {
    const opts = Object.assign({
      importIds: [],               // ID objektov zo sekundárneho modelu na import
      targetContainerId: null,     // ID priestorového kontajnera v primárnom modeli (null = automaticky)
      placementMode: "rebase",     // 'rebase' (zarovnať) | 'preserve' (zachovať)
      offset: { x: 0, y: 0, z: 0 },
      copyProperties: true,
      copyMaterials: true,
      primaryExcludeTypes: [],     // typy, ktoré sa majú z primárneho modelu odstrániť
    }, options || {});

    const warnings = [];
    if (A.schema !== B.schema && A.schema !== "UNKNOWN" && B.schema !== "UNKNOWN") {
      warnings.push(`Rozdielna IFC schéma: primárny = ${A.schema}, sekundárny = ${B.schema}. ` +
        `Zlúčenie prebehne, ale entity zo sekundárneho modelu nemusia byť plne kompatibilné — dôkladne skontrolujte výstup.`);
    }
    if (A.lengthUnit !== B.lengthUnit && A.lengthUnit !== "?" && B.lengthUnit !== "?") {
      warnings.push(`Rozdielne dĺžkové jednotky: primárny = ${A.lengthUnit}, sekundárny = ${B.lengthUnit}. ` +
        `Geometria importovaných objektov môže byť v nesprávnej mierke.`);
    }

    // Vyhľadanie spoločných zdrojov v primárnom modeli
    const primaryCtx = findPrimaryModelContext(A);
    const primaryOwner = findPrimaryOwnerHistory(A);

    // Určenie cieľového kontajnera
    let target = opts.targetContainerId;
    if (!target) {
      const cands = spatialContainers(A);
      target = cands.length ? cands[0].id : null;
    }
    if (!target) throw new Error("V primárnom modeli sa nenašla žiadna priestorová štruktúra (podlažie/budova/areál), do ktorej by sa dali objekty vložiť.");
    const targetEnt = A.entities.get(target);
    const targetPlacement = targetEnt ? objectPlacementOf(targetEnt) : null;

    // Ktorým importovaným produktom sa preruší rodičovský reťazec umiestnenia (režim „rebase“)?
    const cutPlacementRelTo = new Set();
    const importPlacementByProduct = new Map();
    if (opts.placementMode === "rebase") {
      for (const pid of opts.importIds) {
        const pe = B.entities.get(pid);
        if (!pe) continue;
        const pl = objectPlacementOf(pe);
        if (pl != null) { cutPlacementRelTo.add(pl); importPlacementByProduct.set(pid, pl); }
      }
    }

    // 1) uzáver závislostí samotných produktov
    const keep = computeClosure(B, opts.importIds, { cutPlacementRelTo });

    // 2) vzťahy vlastností / materiálov / typov aj s ich definíciami
    let defRels = { rels: [], defClosure: new Set() };
    if (opts.copyProperties || opts.copyMaterials) {
      defRels = collectDefinitionRels(B, new Set(opts.importIds), opts);
      for (const d of defRels.defClosure) keep.add(d);
    }

    // 2b) farby/štýly priradené priamo geometrii (IfcStyledItem) — nezávisí od
    // materiálov ani property setov, ide o vizuálny vzhľad importovaných objektov.
    const styledSeeds = collectStyledItemSeeds(B, keep);
    if (styledSeeds.length) {
      const styleClosure = computeClosure(B, styledSeeds, { cutPlacementRelTo: new Set() });
      for (const d of styleClosure) keep.add(d);
    }

    // 3) pridelenie nových ID všetkým zachovaným entitám zo sekundárneho modelu
    const idMap = new Map();
    let next = A.maxId + 1;
    // stabilné poradie = pôvodné poradie v súbore
    for (const id of B.order) if (keep.has(id)) idMap.set(id, next++);

    // mapovacia funkcia použitá pri prepisovaní tiel zachovaných sekundárnych entít
    function mapRef(oldId) {
      if (idMap.has(oldId)) return idMap.get(oldId);
      const e = B.entities.get(oldId);
      if (!e) return "$";
      if (SHARED_RESOURCE_TYPES.has(e.type)) {
        // reprezentačný kontext -> kontext primárneho modelu; priradenie jednotiek -> null
        if (e.type === "IFCUNITASSIGNMENT") return "$";
        return primaryCtx != null ? primaryCtx : "$";
      }
      if (e.type === "IFCOWNERHISTORY") return primaryOwner != null ? primaryOwner : "$";
      if (SPATIAL_TYPES.has(e.type)) return "$"; // štruktúra, ktorú sme nekopírovali
      return "$";
    }

    // 4) zápis zachovaných sekundárnych entít (prečíslovaných a prelinkovaných)
    const emitted = [];
    for (const id of B.order) {
      if (!keep.has(id)) continue;
      const e = B.entities.get(id);
      let body = rewriteBody(e.body, mapRef);
      emitted.push({ id: idMap.get(id), body, type: e.type, origId: id });
    }

    // 4b) zarovnanie umiestnenia produktov na umiestnenie cieľového kontajnera
    if (opts.placementMode === "rebase") {
      for (const [pid, plOld] of importPlacementByProduct) {
        const plNew = idMap.get(plOld);
        if (plNew == null) continue;
        const rec = emitted.find(x => x.id === plNew);
        if (!rec) continue;
        // rec.body má tvar IFCLOCALPLACEMENT(<relTo>,<relPlacement>)
        const args = topLevelArgs(rec.body);
        const relTo = targetPlacement != null ? "#" + targetPlacement : "$";
        let relPlacement = args[1] || "$";
        // ak je zadaný manuálny posun, aplikujeme ho na bod umiestnenia
        if (opts.offset && (opts.offset.x || opts.offset.y || opts.offset.z)) {
          relPlacement = applyOffsetToPlacement(relPlacement, emitted, opts.offset);
        }
        rec.body = `IFCLOCALPLACEMENT(${relTo},${relPlacement})`;
      }
    } else if (opts.offset && (opts.offset.x || opts.offset.y || opts.offset.z)) {
      // režim zachovania pôvodného umiestnenia + posun: posunieme vlastné umiestnenie každého produktu
      for (const pid of opts.importIds) {
        const plOld = objectPlacementOf(B.entities.get(pid) || {});
        if (plOld == null) continue;
        const plNew = idMap.get(plOld);
        const rec = emitted.find(x => x.id === plNew);
        if (!rec) continue;
        const args = topLevelArgs(rec.body);
        const relPlacement = applyOffsetToPlacement(args[1] || "$", emitted, opts.offset);
        rec.body = `IFCLOCALPLACEMENT(${args[0] || "$"},${relPlacement})`;
      }
    }

    // 5) prepis definičných vzťahov (RelatedObjects obmedzíme len na importované objekty)
    const newRelEntities = [];
    for (const r of defRels.rels) {
      const a = topLevelArgs(r.ent.body);
      const newRelated = "(" + r.keptRelated.map(id => "#" + idMap.get(id)).filter(Boolean).join(",") + ")";
      // telo poskladáme argument po argumente, ostatné odkazy prepíšeme
      const rebuilt = a.map((arg, idx) => {
        if (idx === r.relatedIdx) return newRelated;
        return rewriteBody(arg, mapRef);
      });
      const id = next++;
      newRelEntities.push({ id, body: `${r.ent.type}(${rebuilt.join(",")})` });
    }

    // 7a) zistenie, ktoré entity primárneho modelu sa majú odstrániť (vylúčené typy + kaskáda)
    const excl = new Set(opts.primaryExcludeTypes.map(t => t.toUpperCase()));
    const droppedPrimaryIds = new Set();
    if (excl.size) {
      for (const e of A.entities.values()) if (excl.has(e.type)) droppedPrimaryIds.add(e.id);
      // kaskáda: odstránime vzťahy, ktoré prídu o povinný skalárny odkaz alebo
      // ktorých zoznam členov ostane prázdny. Iterujeme až do ustálenia.
      let changed = true, guard = 0;
      while (changed && guard++ < 10) {
        changed = false;
        for (const e of A.entities.values()) {
          if (droppedPrimaryIds.has(e.id)) continue;
          if (!e.type.startsWith(REL_PREFIX)) continue;
          const c = cleanBodyRemovingRefs(e.body, droppedPrimaryIds);
          if (c.emptiedList || c.scalarDropped) { droppedPrimaryIds.add(e.id); changed = true; }
        }
      }
    }

    // 6) zaradenie do štruktúry: importované produkty pridáme do existujúceho
    //    IfcRelContainedInSpatialStructure cieľového kontajnera (alebo vytvoríme nový).
    const importedNewIds = opts.importIds.map(id => idMap.get(id)).filter(Boolean);
    const containment = buildContainment(A, target, primaryOwner, importedNewIds, droppedPrimaryIds, () => next++);

    // 7b) poskladanie tela primárneho modelu
    const primaryLines = [];
    for (const id of A.order) {
      const e = A.entities.get(id);
      if (droppedPrimaryIds.has(id)) continue;
      // ak ide o vzťah zaradenia, ktorý rozširujeme, preskočíme ho (zapíše sa nižšie)
      if (containment.replacedRelId === id) continue;
      let body = e.body;
      if (droppedPrimaryIds.size) body = cleanBodyRemovingRefs(body, droppedPrimaryIds).body;
      primaryLines.push(`#${id}=${body};`);
    }

    // 8) zostavenie výsledného textu
    // POZOR: nikdy nie `lines.push(...primaryLines)` — spread odovzdá každý riadok
    // ako samostatný argument volania a pri modeli so stotisícmi entít to prekročí
    // veľkosť zásobníka volaní („Maximum call stack size exceeded“).
    const lines = primaryLines.slice();
    lines.push(`/* ==== objekty importované zo sekundárneho modelu ==== */`);
    for (const e of emitted) lines.push(`#${e.id}=${e.body};`);
    for (const e of newRelEntities) lines.push(`#${e.id}=${e.body};`);
    for (const l of containment.lines) lines.push(l);

    const out = A.header + "\n" + lines.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n";

    const report = {
      warnings,
      schemaPrimary: A.schema, schemaSecondary: B.schema,
      importedProducts: opts.importIds.length,
      copiedEntities: emitted.length,
      copiedRelationships: newRelEntities.length + (containment.created ? 1 : 0),
      targetContainer: targetEnt ? (productName(targetEnt) || targetEnt.type) : String(target),
      targetContainerId: target,
      droppedFromPrimary: droppedPrimaryIds.size,
      placementMode: opts.placementMode,
      idOffset: A.maxId,
      totalEntitiesOut: primaryLines.length + emitted.length + newRelEntities.length + containment.lines.filter(l => l.startsWith("#")).length
    };

    return { ifc: out, report, idMap };
  }

  // Pripočíta manuálny posun XYZ k bodu IfcCartesianPoint, na ktorý sa odkazuje
  // IfcAxis2Placement3D (zadaný ako "#id"). Zapísaný bod priamo upravíme.
  function applyOffsetToPlacement(relPlacementArg, emitted, offset) {
    const m = /^#(\d+)$/.exec(relPlacementArg.trim());
    if (!m) return relPlacementArg;
    const axisRec = emitted.find(x => x.id === +m[1]);
    if (!axisRec || axisRec.type !== "IFCAXIS2PLACEMENT3D") return relPlacementArg;
    const a = topLevelArgs(axisRec.body); // (Location, Axis, RefDirection)
    const locM = /^#(\d+)$/.exec((a[0] || "").trim());
    if (!locM) return relPlacementArg;
    const ptRec = emitted.find(x => x.id === +locM[1]);
    if (!ptRec || ptRec.type !== "IFCCARTESIANPOINT") return relPlacementArg;
    const coordsArg = topLevelArgs(ptRec.body)[0] || "()";
    const nums = coordsArg.replace(/^\(|\)$/g, "").split(",").map(s => parseFloat(s.trim()) || 0);
    while (nums.length < 3) nums.push(0);
    nums[0] += offset.x || 0; nums[1] += offset.y || 0; nums[2] += offset.z || 0;
    ptRec.body = `IFCCARTESIANPOINT((${nums.map(n => formatNum(n)).join(",")}))`;
    return relPlacementArg;
  }
  function formatNum(n) {
    if (Number.isInteger(n)) return n + ".";
    return String(n);
  }

  // Vytvorí alebo rozšíri vzťah zaradenia do priestorovej štruktúry pre cieľový kontajner.
  function buildContainment(A, targetId, ownerId, newProductIds, droppedIds, nextId) {
    // nájdeme existujúci IfcRelContainedInSpatialStructure, ktorého RelatingStructure = cieľ
    for (const e of A.entities.values()) {
      if (e.type !== "IFCRELCONTAINEDINSPATIALSTRUCTURE") continue;
      if (droppedIds && droppedIds.has(e.id)) continue; // tento vzťah bol odstránený
      const a = topLevelArgs(e.body);
      const relating = (a[5] || "").trim();
      if (relating === "#" + targetId) {
        const existing = refsIn(a[4] || "").filter(id => !(droppedIds && droppedIds.has(id)));
        const all = existing.concat(newProductIds);
        const listArg = "(" + all.map(id => "#" + id).join(",") + ")";
        const rebuilt = a.slice();
        rebuilt[4] = listArg;
        return {
          created: false,
          replacedRelId: e.id,
          lines: [`#${e.id}=IFCRELCONTAINEDINSPATIALSTRUCTURE(${rebuilt.join(",")});`]
        };
      }
    }
    // žiadny neexistuje -> vytvoríme nový
    const id = nextId();
    const guid = newIfcGuid();
    const owner = ownerId != null ? "#" + ownerId : "$";
    const list = "(" + newProductIds.map(i => "#" + i).join(",") + ")";
    return {
      created: true,
      replacedRelId: null,
      lines: [`#${id}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid}',${owner},$,$,${list},#${targetId});`]
    };
  }

  function mergeIFC(primaryText, secondaryText, options) {
    const A = parseIFC(primaryText);
    const B = parseIFC(secondaryText);
    return mergeParsed(A, B, options);
  }

  // ---------------------------------------------------------------------------
  // Kontrola integrity (používajú ju testy a voliteľne aj rozhranie)
  // ---------------------------------------------------------------------------
  function validate(text) {
    const m = parseIFC(text);
    const problems = [];
    const seen = new Set();
    for (const id of m.order) {
      if (seen.has(id)) problems.push(`Duplicitné ID #${id}`);
      seen.add(id);
    }
    let dangling = 0;
    for (const e of m.entities.values()) {
      for (const r of refsIn(e.body)) {
        if (!m.entities.has(r)) { dangling++; if (dangling <= 20) problems.push(`Visiaca referencia #${r} v #${e.id} (${e.type})`); }
      }
    }
    // presne jeden projekt
    const projects = [...m.entities.values()].filter(e => e.type === "IFCPROJECT").length;
    if (projects !== 1) problems.push(`Očakával sa práve 1 IFCPROJECT, nájdených ${projects}`);
    return { ok: problems.length === 0, problems, dangling, count: m.entities.size };
  }

  const api = {
    parseIFC, mergeIFC, mergeParsed, validate,
    importableObjects, typeBreakdown, spatialContainers,
    productName, globalId, newIfcGuid,
    _internals: { refsIn, topLevelArgs, splitStatements, maskStrings, rewriteBody }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IFCMerge = api;
})(typeof self !== "undefined" ? self : this);
