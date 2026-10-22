/* model.js — 3D prehliadač IFC modelov a koordinácia viacerých súborov (nástroj [01]).
 *
 * Geometriu z IFC vyrába knižnica web-ifc (WebAssembly), kreslí three.js — obe sa
 * stiahnu z CDN až pri prvom otvorení modelu (adresy v import mape v index.html).
 * Súbory sa nikam neodosielajú, všetko beží v prehliadači.
 *
 * Viac súborov naraz: každý model má vlastnú skupinu v scéne. web-ifc posúva
 * geometriu k počiatku (COORDINATE_TO_ORIGIN), preto sa všetky modely vztiahnu
 * na posun prvého nahratého — spolu tak sedia v spoločnom súradnicovom systéme
 * projektu, ako pri koordinácii profesií.
 *
 * Trasa (IfcAlignment, IFC 4.3): os sa vykreslí so staničením a v ľubovoľnom
 * staničení sa urobí priečny rez — zvislá rovina kolmá na smer trasy. Rez sa
 * počíta priamo z trojuholníkov modelov a kreslí sa v 2D (odsun od osi × výška).
 * Jadro trasy je v js/ifc-alignment.js.
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var AL = window.IFCAlignment;

  var WASM_PATH = "https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/";
  // farby modelov v režime „farba podľa modelu“ — dobre rozlíšiteľné aj vedľa seba
  var MODEL_COLORS = ["#2F6FB0", "#C2571A", "#2E8B57", "#8E44AD", "#B8860B", "#C0392B", "#16A085", "#5D6D7E"];
  var HILITE = 0xF2A900;           // vybraný prvok
  var AXIS_COLOR = 0xD0216A;       // os trasy
  var CHUNK_MAX_VERTS = 1500000;   // jeden blok geometrie (ostatné sa pridajú do ďalšieho)
  var HIDDEN_BY_DEFAULT = { IFCSPACE: 1, IFCOPENINGELEMENT: 1, IFCVIRTUALELEMENT: 1, IFCANNOTATION: 1 };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c];
    });
  }
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return "—";
    return n.toLocaleString("sk-SK", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function pretty(t) { return String(t || "").replace(/^IFC/, "Ifc"); }
  function prettyCls(t) {
    // IFCWALLSTANDARDCASE → IfcWallStandardCase podľa registra schémy, ak ho poznáme
    var D = window.IFCDocs, n = D && D.nameOf ? D.nameOf(t) : null;
    return n || pretty(t);
  }
  // drobné nastavenia rozhrania si pamätá prehliadač — pri zablokovanom úložisku sa nič nestane
  function readPref(k, def) { try { var v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; } }
  function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* bez úložiska */ } }
  function plural(n, a, b, c) { return n === 1 ? a : (n >= 2 && n <= 4 ? b : c); }

  // =========================================================================
  //  Knižnice (načítajú sa až na požiadanie)
  // =========================================================================
  var Lib = null, api = null, libsP = null;
  function loadLibs() {
    if (libsP) return libsP;
    libsP = Promise.all([
      import("three"),
      import("three/addons/controls/OrbitControls.js"),
      import("three/addons/renderers/CSS2DRenderer.js"),
      import("web-ifc")
    ]).then(function (m) {
      Lib = { T: m[0], Orbit: m[1].OrbitControls, CSS2D: m[2].CSS2DRenderer, Label: m[2].CSS2DObject, W: m[3] };
      api = new Lib.W.IfcAPI();
      api.SetWasmPath(WASM_PATH, true);
      // jednovláknová verzia — viacvláknová by vyžadovala izoláciu stránky (COOP/COEP)
      return api.Init(undefined, true);
    }).then(function () {
      try { api.SetLogLevel(Lib.W.LogLevel ? Lib.W.LogLevel.LOG_LEVEL_OFF : 6); } catch (e) { /* staršie verzie */ }
    });
    libsP.catch(function () { libsP = null; });
    return libsP;
  }

  // =========================================================================
  //  Stav
  // =========================================================================
  var st = {
    models: [],          // načítané modely (viď loadModel)
    origin: null,        // matica posunu prvého modelu (spoločný počiatok scény)
    uid: 0,
    sel: null,           // { m, id }
    hidden: new Set(),   // "uid:id" skryté prvky
    isolate: null,       // Set "uid:id" — zobrazené len tieto
    colorMode: "file",   // file | model
    ghost: false,
    sideOpen: readPref("md.side", "1") === "1",   // panel vlastností
    geo: {
      georef: null,      // súradnice projektu ↔ mapa (js/ifc-geo.js)
      manual: false,     // georeferencovanie zadané ručne — nové modely ho neprepíšu
      note: "",          // odkiaľ sa poloha zistila
      opt: { base: "ortofoto", terrain: "dem", margin: 250, opacity: 1, country: "auto" },
      mesh: null, model: null, busy: false, status: "", attr: ""
    },
    busy: false,
    sec: {
      al: null,          // { m, a } aktívna trasa
      station: 0, step: 20, width: 0, clip: "none", band: 10,
      data: null,        // posledný vypočítaný rez
      view: null,        // { s, cu, cv } — mierka a stred 2D pohľadu
      mode: "cross",     // cross = priečny rez · long = pozdĺžny profil
      exag: 10,          // prevýšenie výšok v profile
      prof: null,        // vypočítaný pozdĺžny profil (zneplatní sa pri zmene viditeľnosti)
      pview: null        // { sx, cs, cv } — mierka a stred profilu
    }
  };

  var three = null;      // { renderer, scene, camera, controls, labels, … } po inicializácii

  // =========================================================================
  //  Scéna
  // =========================================================================
  function initScene() {
    if (three) return;
    var T = Lib.T, host = $("mdView");
    var renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0xF3F2EE, 1);
    host.insertBefore(renderer.domElement, host.firstChild);
    renderer.domElement.className = "md__gl";

    var labels = new Lib.CSS2D();
    labels.domElement.className = "md__labels";
    host.insertBefore(labels.domElement, renderer.domElement.nextSibling);

    var scene = new T.Scene();
    scene.add(new T.HemisphereLight(0xffffff, 0x8a877c, 1.9));
    var sun = new T.DirectionalLight(0xffffff, 1.4); sun.position.set(0.6, 1, 0.35);
    var fill = new T.DirectionalLight(0xffffff, 0.5); fill.position.set(-0.5, 0.3, -0.8);
    scene.add(sun, fill);

    var camera = new T.PerspectiveCamera(45, 1, 0.05, 20000);
    camera.position.set(30, 25, 30);
    var controls = new Lib.Orbit(camera, renderer.domElement);
    controls.screenSpacePanning = true;
    controls.enableDamping = false;
    controls.addEventListener("change", requestRender);

    var secGroup = new T.Group(); secGroup.renderOrder = 10;
    scene.add(secGroup);

    three = { renderer: renderer, labels: labels, scene: scene, camera: camera, controls: controls,
              secGroup: secGroup, clip: [], raycaster: new T.Raycaster(), hilite: null };

    new ResizeObserver(resize).observe(host);
    wireViewport();
    resize();
  }

  var renderPending = false;
  function requestRender() {
    if (renderPending || !three) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false;
      three.renderer.render(three.scene, three.camera);
      three.labels.render(three.scene, three.camera);
    });
  }
  function resize() {
    if (!three) return;
    var host = $("mdView"), w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    three.renderer.setSize(w, h, false);
    three.renderer.domElement.style.width = w + "px";
    three.renderer.domElement.style.height = h + "px";
    three.labels.setSize(w, h);
    three.camera.aspect = w / h;
    three.camera.updateProjectionMatrix();
    requestRender();
  }

  // =========================================================================
  //  Načítanie modelu
  // =========================================================================
  /* Rastúce typové pole — geometriu skladáme bez medzikroku cez JS polia. */
  function Grow(Type, n) { this.T = Type; this.a = new Type(n || 4096); this.n = 0; }
  Grow.prototype.need = function (k) {
    if (this.n + k <= this.a.length) return;
    var len = this.a.length * 2; while (len < this.n + k) len *= 2;
    var b = new this.T(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  };
  Grow.prototype.done = function () { return this.a.slice(0, this.n); };

  function newChunk(m, cls, transparent) {
    return { m: m, cls: cls, transparent: transparent,
             pos: new Grow(Float32Array), nor: new Grow(Float32Array), col: new Grow(Float32Array),
             idx: new Grow(Uint32Array), verts: 0, ranges: [], mesh: null, index: null };
  }

  function typeName(code) {
    try { return String(api.GetNameFromTypeCode(code) || "").toUpperCase(); } catch (e) { return ""; }
  }

  function reader(modelID) {
    return {
      line: function (id) {
        if (id == null) return null;
        try { return api.GetLine(modelID, id, false); } catch (e) { return null; }
      },
      ids: function (t) {
        var out = [];
        try {
          var v = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName(t));
          for (var i = 0; i < v.size(); i++) out.push(v.get(i));
        } catch (e) { /* trieda v tejto schéme neexistuje */ }
        return out;
      },
      typeName: typeName
    };
  }

  function readMapConversion(R) {
    var id = R.ids("IFCMAPCONVERSION")[0];
    var e = id != null ? R.line(id) : null;
    if (!e) return null;
    var v = function (x) { return x == null ? 0 : +(x.value !== undefined ? x.value : x._representationValue) || 0; };
    var crs = R.line(e.TargetCRS && e.TargetCRS.value);
    // posuny sú v jednotkách mapy (MapUnit), bez nej v jednotkách projektu
    var f = AL ? AL.units(R).length : 1, mu = crs && crs.MapUnit ? R.line(crs.MapUnit.value) : null;
    if (mu && mu.Prefix !== undefined) f = { MILLI: 1e-3, CENTI: 1e-2, DECI: 0.1, KILO: 1e3 }[v(mu.Prefix) || ""] || 1;
    var nm = function (x) { return x && x.value != null ? String(x.value) : ""; };
    return {
      e: v(e.Eastings) * f, n: v(e.Northings) * f, h: v(e.OrthogonalHeight) * f,
      ax: e.XAxisAbscissa ? v(e.XAxisAbscissa) : 1, ay: e.XAxisOrdinate ? v(e.XAxisOrdinate) : 0,
      scale: e.Scale ? v(e.Scale) || 1 : 1,
      crs: crs ? nm(crs.Name) : "", crsDesc: crs ? nm(crs.Description) + " " + nm(crs.GeodeticDatum) : ""
    };
  }

  function loadModel(file, onStep) {
    var T = Lib.T;
    return file.arrayBuffer().then(function (buf) {
      onStep("spracúva sa geometria…");
      return new Promise(function (r) { setTimeout(r, 30); }).then(function () { return buf; });
    }).then(function (buf) {
      var modelID = api.OpenModel(new Uint8Array(buf), { COORDINATE_TO_ORIGIN: true });
      if (modelID < 0) throw new Error("Súbor sa nepodarilo otvoriť.");
      var schema = api.GetModelSchema(modelID) || "";
      var m = {
        uid: ++st.uid, name: file.name, file: file, size: file.size, modelID: modelID, schema: schema,
        color: MODEL_COLORS[(st.uid - 1) % MODEL_COLORS.length], visible: true,
        group: new T.Group(), chunks: [], products: new Map(), classes: new Map(), alignments: [],
        Mi: new T.Matrix4(), bbox: new T.Box3()
      };
      var chunks = new Map();
      function chunkFor(cls, transparent, nv) {
        var key = cls + "|" + (transparent ? 1 : 0), c = chunks.get(key);
        if (!c || c.verts + nv > CHUNK_MAX_VERTS) {
          c = newChunk(m, cls, transparent);
          chunks.set(key, c); m.chunks.push(c);
        }
        return c;
      }

      var typeCache = new Map();
      api.StreamAllMeshes(modelID, function (mesh) {
        var id = mesh.expressID, cls = typeCache.get(id);
        if (cls === undefined) {
          try { cls = typeName(api.GetLineType(modelID, id)); } catch (e) { cls = ""; }
          typeCache.set(id, cls);
        }
        var prod = m.products.get(id);
        if (!prod) {
          prod = { id: id, cls: cls || "IFCPRODUCT", parts: [], bb: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], color: null };
          m.products.set(id, prod);
        }
        var geoms = mesh.geometries;
        for (var gi = 0; gi < geoms.size(); gi++) {
          var pg = geoms.get(gi);
          var g = api.GetGeometry(modelID, pg.geometryExpressID);
          var vd = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
          var id3 = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
          var nv = vd.length / 6;
          if (!nv || !id3.length) { if (g.delete) g.delete(); continue; }
          var c = pg.color, transparent = c.w < 0.99;
          // bez štýlu dáva web-ifc čistú bielu — na svetlom pozadí by splývala
          if (c.x === 1 && c.y === 1 && c.z === 1) c = { x: 0.78, y: 0.77, z: 0.74, w: c.w };
          var ch = chunkFor(prod.cls, transparent, nv);
          var M = pg.flatTransformation, base = ch.verts;
          ch.pos.need(nv * 3); ch.nor.need(nv * 3); ch.col.need(nv * 4); ch.idx.need(id3.length);
          var P = ch.pos.a, N = ch.nor.a, C = ch.col.a, bb = prod.bb;
          for (var k = 0; k < nv; k++) {
            var x = vd[k * 6], y = vd[k * 6 + 1], z = vd[k * 6 + 2];
            var nx = vd[k * 6 + 3], ny = vd[k * 6 + 4], nz = vd[k * 6 + 5];
            var X = M[0] * x + M[4] * y + M[8] * z + M[12];
            var Y = M[1] * x + M[5] * y + M[9] * z + M[13];
            var Z = M[2] * x + M[6] * y + M[10] * z + M[14];
            var o = ch.pos.n; P[o] = X; P[o + 1] = Y; P[o + 2] = Z; ch.pos.n += 3;
            o = ch.nor.n;
            N[o] = M[0] * nx + M[4] * ny + M[8] * nz;
            N[o + 1] = M[1] * nx + M[5] * ny + M[9] * nz;
            N[o + 2] = M[2] * nx + M[6] * ny + M[10] * nz; ch.nor.n += 3;
            o = ch.col.n; C[o] = c.x; C[o + 1] = c.y; C[o + 2] = c.z; C[o + 3] = c.w; ch.col.n += 4;
            if (X < bb[0]) bb[0] = X; if (Y < bb[1]) bb[1] = Y; if (Z < bb[2]) bb[2] = Z;
            if (X > bb[3]) bb[3] = X; if (Y > bb[4]) bb[4] = Y; if (Z > bb[5]) bb[5] = Z;
          }
          var I = ch.idx.a, start = ch.idx.n;
          for (var q = 0; q < id3.length; q++) I[start + q] = id3[q] + base;
          ch.idx.n += id3.length;
          ch.verts += nv;
          ch.ranges.push({ start: start, count: id3.length, id: id });
          prod.parts.push({ ch: ch, start: start, count: id3.length });
          if (!prod.color) prod.color = [c.x, c.y, c.z, c.w];
          if (g.delete) g.delete();
        }
      });

      // posun k počiatku pozná web-ifc až po spracovaní geometrie
      try { m.Mi.fromArray(api.GetCoordinationMatrix(modelID)); } catch (e) { /* bez posunu */ }
      if (!st.origin) st.origin = m.Mi.clone();
      // model i sa presunie do počiatku prvého: M0 · Mi⁻¹
      m.group.matrixAutoUpdate = false;
      m.group.matrix.copy(st.origin).multiply(m.Mi.clone().invert());
      m.group.updateMatrixWorld(true);

      // bloky geometrie → mriežky three.js
      m.chunks.forEach(function (ch) {
        var geo = new T.BufferGeometry();
        ch.posA = ch.pos.done(); ch.idxA = ch.idx.done(); ch.colA = ch.col.done();
        geo.setAttribute("position", new T.BufferAttribute(ch.posA, 3));
        geo.setAttribute("normal", new T.BufferAttribute(ch.nor.done(), 3));
        geo.setAttribute("color", new T.BufferAttribute(ch.colA, 4));
        geo.setIndex(new T.BufferAttribute(ch.idxA.slice(), 1));
        geo.computeBoundingBox(); geo.computeBoundingSphere();
        ch.pos = ch.nor = ch.col = ch.idx = null;
        var mat = new T.MeshLambertMaterial({
          vertexColors: true, side: T.DoubleSide, transparent: ch.transparent,
          depthWrite: !ch.transparent, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
        });
        ch.mesh = new T.Mesh(geo, mat);
        ch.mesh.userData.ch = ch;
        m.group.add(ch.mesh);
      });
      m.products.forEach(function (p) {
        if (!p.parts.length) { m.products.delete(p.id); return; }
        var c = m.classes.get(p.cls);
        if (!c) { c = { n: 0, visible: !HIDDEN_BY_DEFAULT[p.cls] }; m.classes.set(p.cls, c); }
        c.n++;
      });
      m.chunks.forEach(function (ch) {
        if (!m.classes.get(ch.cls) || !m.classes.get(ch.cls).visible) ch.mesh.visible = false;
      });

      // trasy (IFC 4.3) a georeferencovanie
      var R = reader(modelID);
      try { m.alignments = AL ? AL.readAlignments(R) : []; } catch (e) { console.warn("trasa", e); m.alignments = []; }
      try { m.map = readMapConversion(R); } catch (e) { m.map = null; }
      m.alignments.forEach(function (a, i) { a.visible = true; a.key = m.uid + ":" + i; buildAxis(m, a); });

      three.scene.add(m.group);
      m.group.updateMatrixWorld(true);
      m.bbox.setFromObject(m.group);
      return m;
    });
  }

  /* IFC (m, Z hore) → lokálne súradnice skupiny modelu (Y hore, posunuté ako web-ifc). */
  function ifcToLocal(m, x, y, z) {
    return new Lib.T.Vector3(x, z, -y).applyMatrix4(m.Mi);
  }
  function ifcToWorld(m, x, y, z) {
    return ifcToLocal(m, x, y, z).applyMatrix4(m.group.matrixWorld);
  }

  // ---- os trasy so staničením --------------------------------------------
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function buildAxis(m, a) {
    var T = Lib.T;
    var pts = a.sample(Math.max(0.5, Math.min(5, a.length / 400)));
    var arr = [];
    pts.forEach(function (p) { var v = ifcToLocal(m, p.x, p.y, p.z); arr.push(v.x, v.y, v.z); });
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(arr, 3));
    var line = new T.Line(geo, new T.LineBasicMaterial({ color: AXIS_COLOR, depthTest: false, transparent: true }));
    line.renderOrder = 20;
    var grp = new T.Group();
    grp.add(line);

    // popisy staničenia — okolo 12 na celú trasu, aby sa neprekrývali
    var step = niceStep(a.length / 12);
    if (step < 10) step = 10;
    var s0 = Math.ceil(a.startStation / step) * step;
    for (var s = s0; s <= a.endStation + 1e-6; s += step) addTick(s, false);
    addTick(a.startStation, true); addTick(a.endStation, true);
    function addTick(stn, edge) {
      var p = a.atStation(stn), v = ifcToLocal(m, p.x, p.y, p.z);
      var el = document.createElement("div");
      el.className = "md-tick" + (edge ? " md-tick--edge" : "");
      el.textContent = AL.formatStation(stn, edge ? 3 : 0).replace(/,(\d{3})\.0*$/, ",$1");
      var lab = new Lib.Label(el);
      lab.position.copy(v);
      grp.add(lab);
    }
    a.obj = grp;
    m.group.add(grp);
  }

  // =========================================================================
  //  Viditeľnosť, farby, výber
  // =========================================================================
  function key(m, id) { return m.uid + ":" + id; }
  function productShown(m, p) {
    var k = key(m, p.id);
    if (st.hidden.has(k)) return false;
    if (st.isolate && !st.isolate.has(k)) return false;
    var c = m.classes.get(p.cls);
    return !c || c.visible;
  }

  /* Prepočíta index blokov — skryté prvky z neho vypadnú. */
  function rebuildIndices() {
    st.models.forEach(function (m) {
      m.chunks.forEach(function (ch) {
        var c = m.classes.get(ch.cls);
        var classOn = !c || c.visible;
        ch.mesh.visible = classOn && m.visible;
        if (!ch.mesh.visible) return;
        var src = ch.idxA, out = new Uint32Array(src.length), n = 0, all = true;
        ch.ranges.forEach(function (r) {
          var k = key(m, r.id);
          if (st.hidden.has(k) || (st.isolate && !st.isolate.has(k))) { all = false; return; }
          out.set(src.subarray(r.start, r.start + r.count), n); n += r.count;
        });
        var geo = ch.mesh.geometry;
        geo.setIndex(new Lib.T.BufferAttribute(all ? src.slice() : out.slice(0, n), 1));
        ch.mesh.visible = n > 0 || all;
      });
      m.alignments.forEach(function (a) { if (a.obj) a.obj.visible = m.visible && a.visible; });
    });
    st.sec.prof = null;
    refreshSection();
    requestRender();
  }

  function applyMaterials() {
    var T = Lib.T;
    st.models.forEach(function (m) {
      m.chunks.forEach(function (ch) {
        var mat = ch.mesh.material;
        mat.vertexColors = st.colorMode === "file";
        mat.color = new T.Color(st.colorMode === "model" ? m.color : 0xffffff);
        var transp = st.ghost || ch.transparent;
        mat.transparent = transp;
        mat.opacity = st.ghost ? 0.18 : (ch.transparent && st.colorMode === "model" ? 0.4 : 1);
        mat.depthWrite = !transp;
        mat.clippingPlanes = three.clip.length ? three.clip : null;
        mat.needsUpdate = true;
      });
    });
    if (three.hilite) {
      three.hilite.material.clippingPlanes = three.clip.length ? three.clip : null;
      three.hilite.material.needsUpdate = true;
    }
    if (st.geo.mesh) {
      var gm = st.geo.mesh.material;
      gm.clippingPlanes = three.clip.length ? three.clip : null;
      gm.opacity = st.geo.opt.opacity;
      gm.transparent = st.geo.opt.opacity < 1;
      gm.depthWrite = st.geo.opt.opacity >= 1;
      gm.needsUpdate = true;
    }
    requestRender();
  }

  function clearHilite() {
    if (three && three.hilite) {
      three.hilite.parent.remove(three.hilite);
      three.hilite.geometry.dispose();
      three.hilite = null;
    }
  }
  function showHilite(m, p) {
    clearHilite();
    var T = Lib.T, arr = [];
    p.parts.forEach(function (pt) {
      var P = pt.ch.posA, I = pt.ch.idxA;
      for (var i = pt.start; i < pt.start + pt.count; i++) { var v = I[i] * 3; arr.push(P[v], P[v + 1], P[v + 2]); }
    });
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    var mat = new T.MeshLambertMaterial({ color: HILITE, emissive: 0x6b4a00, side: T.DoubleSide,
      transparent: true, opacity: 0.92, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      clippingPlanes: three.clip.length ? three.clip : null });
    var mesh = new T.Mesh(geo, mat);
    mesh.renderOrder = 5;
    m.group.add(mesh);
    three.hilite = mesh;
  }

  function select(m, id, opts) {
    opts = opts || {};
    if (!m || id == null) {
      st.sel = null; clearHilite(); renderSide(); drawSection(); requestRender(); return;
    }
    var p = m.products.get(id);
    st.sel = { m: m, id: id };
    if (p) showHilite(m, p); else clearHilite();
    if (opts.focus && p) focusBox(boxOfProduct(m, p));
    renderSide();
    drawSection();
    requestRender();
  }

  function boxOfProduct(m, p) {
    var T = Lib.T, b = new T.Box3(new T.Vector3(p.bb[0], p.bb[1], p.bb[2]), new T.Vector3(p.bb[3], p.bb[4], p.bb[5]));
    return b.applyMatrix4(m.group.matrixWorld);
  }

  function visibleBox() {
    var T = Lib.T, box = new T.Box3();
    st.models.forEach(function (m) {
      if (!m.visible) return;
      m.chunks.forEach(function (ch) { if (ch.mesh.visible) box.expandByObject(ch.mesh); });
      m.alignments.forEach(function (a) { if (a.obj && a.obj.visible) box.expandByObject(a.obj.children[0]); });
    });
    return box;
  }

  function focusBox(box, dir) {
    if (!three || box.isEmpty()) return;
    var T = Lib.T, c = box.getCenter(new T.Vector3()), size = box.getSize(new T.Vector3());
    var r = Math.max(size.length() / 2, 0.5);
    var cam = three.camera;
    var d = dir ? dir.clone().normalize() : cam.position.clone().sub(three.controls.target).normalize();
    if (!isFinite(d.x) || d.lengthSq() < 0.5) d.set(1, 0.8, 1).normalize();
    // úzky pohľad orezáva po šírke — rozhoduje menší z oboch uhlov záberu
    var half = Math.min(cam.fov * Math.PI / 360, Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect));
    var dist = r / Math.sin(half) * 1.05;
    cam.position.copy(c).addScaledVector(d, dist);
    cam.near = Math.max(0.01, dist / 2000);
    cam.far = Math.max(dist * 20, r * 40);
    cam.updateProjectionMatrix();
    three.controls.target.copy(c);
    three.controls.update();
    requestRender();
  }

  // =========================================================================
  //  Interakcia v 3D
  // =========================================================================
  function clippedOut(p) {
    for (var i = 0; i < three.clip.length; i++) if (three.clip[i].distanceToPoint(p) < 0) return true;
    return false;
  }
  function pick(ev) {
    var T = Lib.T, rect = three.renderer.domElement.getBoundingClientRect();
    var ndc = new T.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    three.raycaster.setFromCamera(ndc, three.camera);
    var meshes = [];
    st.models.forEach(function (m) {
      if (m.visible) m.chunks.forEach(function (ch) { if (ch.mesh.visible) meshes.push(ch.mesh); });
    });
    var hits = three.raycaster.intersectObjects(meshes, false);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (clippedOut(h.point)) continue;
      var ch = h.object.userData.ch, idx = h.object.geometry.index.array[h.faceIndex * 3];
      // trojuholník → prvok: hľadáme rozsah v pôvodnom indexe podľa prvého vrcholu
      var id = rangeOfVertex(ch, idx);
      if (id != null) return { m: ch.m, id: id, point: h.point };
    }
    return null;
  }
  function rangeOfVertex(ch, vtx) {
    // rozsahy idú vzostupne aj podľa vrcholov (pridávané postupne)
    var R = ch.ranges, lo = 0, hi = R.length - 1, I = ch.idxA;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (I[R[mid].start] <= vtx) lo = mid; else hi = mid - 1;
    }
    return R[lo] ? R[lo].id : null;
  }

  function wireViewport() {
    var el = three.renderer.domElement, down = null;
    el.addEventListener("pointerdown", function (e) { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener("pointerup", function (e) {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) { down = null; return; }
      down = null;
      var h = pick(e);
      if (h) select(h.m, h.id); else select(null);
    });
    el.addEventListener("dblclick", function (e) {
      var h = pick(e);
      if (!h) return;
      three.controls.target.copy(h.point);
      three.controls.update();
      requestRender();
    });
  }

  // =========================================================================
  //  Rez po trase
  // =========================================================================
  function activeAlignment() { return st.sec.al; }

  /* Rovina rezu v staničení: bod osi, smer trasy, smer „doprava“ a hore (svet). */
  function sectionFrame(stn) {
    var T = Lib.T, A = st.sec.al, a = A.a, m = A.m;
    var p = a.atStation(stn);
    var P = ifcToWorld(m, p.x, p.y, p.z);
    var P2 = ifcToWorld(m, p.x + p.tx, p.y + p.ty, p.z);
    var Tn = P2.sub(P.clone()).setY(0).normalize();
    var up = new T.Vector3(0, 1, 0);
    var Rt = new T.Vector3().crossVectors(Tn, up).normalize();
    return { p: p, P: P, T: Tn, R: Rt, U: up };
  }

  /* Prienik viditeľných prvkov všetkých modelov s rovinou rezu.
     Výsledok v 2D: u = odsun od osi (+ vpravo v smere staničenia), v = výška (m). */
  /* Modely, ktoré sa režú — načítané IFC a k nim terén (ak je zobrazený). */
  function cutModels() {
    return st.geo.model && st.geo.mesh && st.geo.mesh.visible ? st.models.concat([st.geo.model]) : st.models;
  }

  function computeSection(stn) {
    var F = sectionFrame(stn), items = [];
    var halfW = st.sec.width > 0 ? st.sec.width : Infinity;
    cutModels().forEach(function (m) {
      if (!m.visible) return;
      var inv = m.group.matrixWorld.clone().invert();
      var P = F.P.clone().applyMatrix4(inv);
      var Tn = F.T.clone().transformDirection(inv), Rt = F.R.clone().transformDirection(inv), U = F.U.clone().transformDirection(inv);
      var px = P.x, py = P.y, pz = P.z, tx = Tn.x, ty = Tn.y, tz = Tn.z;
      var rx = Rt.x, ry = Rt.y, rz = Rt.z, ux = U.x, uy = U.y, uz = U.z, z0 = F.p.z;
      m.products.forEach(function (prod) {
        if (!productShown(m, prod)) return;
        var bb = prod.bb, neg = false, pos = false;
        for (var c = 0; c < 8; c++) {
          var d = ((c & 1 ? bb[3] : bb[0]) - px) * tx + ((c & 2 ? bb[4] : bb[1]) - py) * ty + ((c & 4 ? bb[5] : bb[2]) - pz) * tz;
          if (d < 0) neg = true; else pos = true;
        }
        if (!(neg && pos)) return;
        var segs = [];
        prod.parts.forEach(function (pt) {
          var Pa = pt.ch.posA, I = pt.ch.idxA;
          for (var i = pt.start; i < pt.start + pt.count; i += 3) {
            var a = I[i] * 3, b = I[i + 1] * 3, cc = I[i + 2] * 3;
            var da = (Pa[a] - px) * tx + (Pa[a + 1] - py) * ty + (Pa[a + 2] - pz) * tz;
            var db = (Pa[b] - px) * tx + (Pa[b + 1] - py) * ty + (Pa[b + 2] - pz) * tz;
            var dc = (Pa[cc] - px) * tx + (Pa[cc + 1] - py) * ty + (Pa[cc + 2] - pz) * tz;
            if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
            if (da === 0 && db === 0 && dc === 0) continue;     // trojuholník v rovine — obrys dajú susedia
            var out = [];
            edge(a, da, b, db); edge(b, db, cc, dc); edge(cc, dc, a, da);
            if (out.length >= 4) segs.push(out[0], out[1], out[2], out[3]);
          }
          function edge(i1, d1, i2, d2) {
            if (out.length >= 4) return;
            if (d1 === 0) { pushPt(i1, 0); return; }
            if ((d1 < 0) === (d2 < 0) || d2 === 0) return;
            pushPt(i1, d1 / (d1 - d2), i2);
          }
          function pushPt(i1, t, i2) {
            var x = Pa[i1], y = Pa[i1 + 1], z = Pa[i1 + 2];
            if (t) { x += (Pa[i2] - x) * t; y += (Pa[i2 + 1] - y) * t; z += (Pa[i2 + 2] - z) * t; }
            var u = (x - px) * rx + (y - py) * ry + (z - pz) * rz;
            var v = (x - px) * ux + (y - py) * uy + (z - pz) * uz + z0;
            // rovnaký bod dvakrát (vrchol na rovine) nepridávame
            if (out.length === 2 && Math.abs(out[0] - u) < 1e-9 && Math.abs(out[1] - v) < 1e-9) return;
            out.push(u, v);
          }
        });
        if (!segs.length) return;
        if (halfW !== Infinity) {
          var keep = [];
          for (var s = 0; s < segs.length; s += 4) {
            if (Math.abs(segs[s]) <= halfW || Math.abs(segs[s + 2]) <= halfW) keep.push(segs[s], segs[s + 1], segs[s + 2], segs[s + 3]);
          }
          segs = keep;
          if (!segs.length) return;
        }
        var ch = chain(segs);
        items.push({ m: m, id: prod.id, cls: prod.cls, color: prod.color, segs: segs, loops: ch.loops, open: ch.open });
      });
    });
    // terén siaha ďaleko do strán — v reze sa oreže na šírku modelov s presahom
    var ter = items.filter(function (it) { return it.m.isTerrain; });
    if (ter.length && halfW === Infinity) {
      var lo = Infinity, hi = -Infinity;
      items.forEach(function (it) {
        if (it.m.isTerrain) return;
        for (var i = 0; i < it.segs.length; i += 2) { lo = Math.min(lo, it.segs[i]); hi = Math.max(hi, it.segs[i]); }
      });
      if (!isFinite(lo)) { lo = 0; hi = 0; }
      var pad = Math.max(20, (hi - lo) / 2);
      lo -= pad; hi += pad;
      ter.forEach(function (it) {
        var keep = [];
        for (var i = 0; i < it.segs.length; i += 4) {
          if (Math.max(it.segs[i], it.segs[i + 2]) >= lo && Math.min(it.segs[i], it.segs[i + 2]) <= hi) keep.push(it.segs[i], it.segs[i + 1], it.segs[i + 2], it.segs[i + 3]);
        }
        it.segs = keep;
        var c = chain(keep); it.loops = []; it.open = c.loops.concat(c.open);
      });
      items = items.filter(function (it) { return it.segs.length; });
    }
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    items.forEach(function (it) {
      for (var i = 0; i < it.segs.length; i += 2) {
        var u = it.segs[i], v = it.segs[i + 1];
        if (u < bb[0]) bb[0] = u; if (v < bb[1]) bb[1] = v; if (u > bb[2]) bb[2] = u; if (v > bb[3]) bb[3] = v;
      }
    });
    return { station: stn, frame: F, items: items, bb: bb };
  }

  /* Úsečky rezu → uzavreté obrysy (na výplň) a otvorené čiary. */
  function chain(segs) {
    var Q = 1e4, n = segs.length / 4, adj = new Map(), used = new Uint8Array(n);
    function k(u, v) { return Math.round(u * Q) + "," + Math.round(v * Q); }
    var keys = [];
    for (var i = 0; i < n; i++) {
      var k1 = k(segs[i * 4], segs[i * 4 + 1]), k2 = k(segs[i * 4 + 2], segs[i * 4 + 3]);
      keys.push(k1, k2);
      if (k1 === k2) { used[i] = 1; continue; }
      (adj.get(k1) || adj.set(k1, []).get(k1)).push(i);
      (adj.get(k2) || adj.set(k2, []).get(k2)).push(i);
    }
    function next(kk) {
      var l = adj.get(kk); if (!l) return -1;
      for (var j = 0; j < l.length; j++) if (!used[l[j]]) return l[j];
      return -1;
    }
    var loops = [], open = [];
    for (var s = 0; s < n; s++) {
      if (used[s]) continue;
      used[s] = 1;
      var pts = [segs[s * 4], segs[s * 4 + 1], segs[s * 4 + 2], segs[s * 4 + 3]];
      var startK = keys[s * 2], endK = keys[s * 2 + 1], closed = false;
      for (var guard = 0; guard < n; guard++) {
        var e = next(endK); if (e < 0) break;
        used[e] = 1;
        var fwd = keys[e * 2] === endK;
        var nu = fwd ? segs[e * 4 + 2] : segs[e * 4], nv = fwd ? segs[e * 4 + 3] : segs[e * 4 + 1];
        endK = fwd ? keys[e * 2 + 1] : keys[e * 2];
        if (endK === startK) { closed = true; break; }
        pts.push(nu, nv);
      }
      if (!closed) {
        for (var g2 = 0; g2 < n; g2++) {
          var b = next(startK); if (b < 0) break;
          used[b] = 1;
          var f2 = keys[b * 2] === startK;
          var bu = f2 ? segs[b * 4 + 2] : segs[b * 4], bv = f2 ? segs[b * 4 + 3] : segs[b * 4 + 1];
          startK = f2 ? keys[b * 2 + 1] : keys[b * 2];
          pts.unshift(bu, bv);
          if (startK === endK) { closed = true; break; }
        }
      }
      (closed ? loops : open).push(pts);
    }
    return { loops: loops, open: open };
  }

  function setClip() {
    var T = Lib.T;
    three.clip = [];
    var d = st.sec.data;
    if (d && st.sec.al && st.sec.clip !== "none") {
      var F = d.frame;
      if (st.sec.clip === "ahead") {
        three.clip.push(new T.Plane().setFromNormalAndCoplanarPoint(F.T.clone(), F.P));
      } else if (st.sec.clip === "behind") {
        three.clip.push(new T.Plane().setFromNormalAndCoplanarPoint(F.T.clone().negate(), F.P));
      } else if (st.sec.clip === "band") {
        var b = st.sec.band / 2;
        three.clip.push(new T.Plane().setFromNormalAndCoplanarPoint(F.T.clone(), F.P.clone().addScaledVector(F.T, -b)));
        three.clip.push(new T.Plane().setFromNormalAndCoplanarPoint(F.T.clone().negate(), F.P.clone().addScaledVector(F.T, b)));
      }
    }
    applyMaterials();
  }

  /* Rovina rezu a prienik v 3D scéne. */
  function drawSection3D() {
    var T = Lib.T, g = three.secGroup;
    while (g.children.length) { var c = g.children.pop(); if (c.geometry) c.geometry.dispose(); }
    var d = st.sec.data;
    if (!d || !st.sec.al) { requestRender(); return; }
    var F = d.frame;
    var w = isFinite(d.bb[0]) ? Math.max(Math.abs(d.bb[0]), Math.abs(d.bb[2])) * 2 + 4 : 30;
    if (st.sec.width > 0) w = st.sec.width * 2;
    var hLo = isFinite(d.bb[1]) ? d.bb[1] - 2 : F.p.z - 5, hHi = isFinite(d.bb[3]) ? d.bb[3] + 2 : F.p.z + 5;
    var corners = [[-w / 2, hLo], [w / 2, hLo], [w / 2, hHi], [-w / 2, hHi]].map(function (q) {
      return F.P.clone().addScaledVector(F.R, q[0]).add(new T.Vector3(0, q[1] - F.p.z, 0));
    });
    var pg = new T.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
    var plane = new T.Mesh(pg, new T.MeshBasicMaterial({ color: 0x4B3F8F, transparent: true, opacity: 0.1, side: T.DoubleSide, depthWrite: false }));
    var frame = new T.LineLoop(new T.BufferGeometry().setFromPoints(corners), new T.LineBasicMaterial({ color: 0x4B3F8F, transparent: true, opacity: 0.55 }));
    g.add(plane, frame);
    var arr = [];
    d.items.forEach(function (it) {
      for (var i = 0; i < it.segs.length; i += 2) {
        var p = F.P.clone().addScaledVector(F.R, it.segs[i]).add(new T.Vector3(0, it.segs[i + 1] - F.p.z, 0));
        arr.push(p.x, p.y, p.z);
      }
    });
    if (arr.length) {
      var sg = new T.BufferGeometry();
      sg.setAttribute("position", new T.Float32BufferAttribute(arr, 3));
      var segs = new T.LineSegments(sg, new T.LineBasicMaterial({ color: 0x241C5C, depthTest: false, transparent: true }));
      segs.renderOrder = 30;
      g.add(segs);
    }
    requestRender();
  }

  function refreshSection() {
    if (!st.sec.al || !three) return;
    st.sec.data = computeSection(st.sec.station);
    if (st.sec.mode === "long" && !st.sec.prof) st.sec.prof = computeProfile();
    if (st.sec.clip !== "none") setClip();
    drawSection3D();
    drawSection();
    renderSecInfo();
  }

  function setStation(stn, opts) {
    var a = st.sec.al && st.sec.al.a;
    if (!a) return;
    stn = Math.max(a.startStation, Math.min(a.endStation, stn));
    st.sec.station = stn;
    var keepView = opts && opts.keepView;
    if (!keepView) st.sec.view = null;
    $("secSt").value = AL.formatStation(stn);
    $("secRange").value = String(stn);
    refreshSection();
  }

  function openSection(m, a) {
    st.sec.al = { m: m, a: a };
    st.sec.prof = null; st.sec.pview = null;
    var opts = $("secAl");
    opts.value = a.key;
    $("mdSec").hidden = false;
    var r = $("secRange");
    r.min = String(a.startStation); r.max = String(a.endStation); r.step = "0.001";
    $("secFrom").value = AL.formatStation(a.startStation, 0);
    $("secTo").value = AL.formatStation(a.endStation, 0);
    var s = st.sec.station;
    if (!(s >= a.startStation && s <= a.endStation)) s = a.startStation;
    renderLeft();
    setStation(s);
    requestAnimationFrame(sizeSecCanvas);
  }
  function closeSection() {
    st.sec.al = null; st.sec.data = null; st.sec.prof = null;
    $("mdSec").hidden = true;
    setClip();
    drawSection3D();
    renderLeft();
  }

  // ---- 2D kreslenie rezu ---------------------------------------------------
  var sec2d = { cv: null, ctx: null, w: 0, h: 0, paths: [] };
  function sizeSecCanvas() {
    var cv = $("secCanvas"); if (!cv) return;
    var r = cv.parentElement.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    sec2d.w = Math.max(200, r.width); sec2d.h = Math.max(200, r.height);
    cv.width = Math.round(sec2d.w * dpr); cv.height = Math.round(sec2d.h * dpr);
    cv.style.width = sec2d.w + "px"; cv.style.height = sec2d.h + "px";
    sec2d.cv = cv; sec2d.ctx = cv.getContext("2d"); sec2d.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSection();
  }

  function fitView(d) {
    var bb = d.bb, z = d.frame.p.z;
    var u0 = isFinite(bb[0]) ? Math.min(bb[0], -1) : -10, u1 = isFinite(bb[2]) ? Math.max(bb[2], 1) : 10;
    var v0 = isFinite(bb[1]) ? Math.min(bb[1], z) : z - 5, v1 = isFinite(bb[3]) ? Math.max(bb[3], z) : z + 5;
    if (st.sec.width > 0) { u0 = -st.sec.width; u1 = st.sec.width; }
    var w = Math.max(u1 - u0, 2), h = Math.max(v1 - v0, 2);
    var s = Math.min((sec2d.w - 70) / w, (sec2d.h - 60) / h);
    return { s: s, cu: (u0 + u1) / 2, cv: (v0 + v1) / 2 };
  }
  function toScr(V, u, v) { return [sec2d.w / 2 + (u - V.cu) * V.s, sec2d.h / 2 - (v - V.cv) * V.s]; }
  function fromScr(V, x, y) { return [(x - sec2d.w / 2) / V.s + V.cu, -(y - sec2d.h / 2) / V.s + V.cv]; }

  function itemColor(it, a) {
    var c = st.colorMode === "model" ? hexRgb(it.m.color) : (it.color || [0.6, 0.6, 0.6]).map(function (x) { return x * 255; });
    return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + a + ")";
  }
  function strokeColor(it) {
    var c = st.colorMode === "model" ? hexRgb(it.m.color) : (it.color || [0.4, 0.4, 0.4]).map(function (x) { return x * 255; });
    return "rgb(" + c.map(function (x) { return Math.round(x * 0.55); }).join(",") + ")";
  }
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }

  function drawSection() {
    var ctx = sec2d.ctx, d = st.sec.data;
    if (!ctx || $("mdSec").hidden) return;
    if (st.sec.mode === "long") { drawProfile(); return; }
    ctx.clearRect(0, 0, sec2d.w, sec2d.h);
    ctx.fillStyle = "#FCFCFA"; ctx.fillRect(0, 0, sec2d.w, sec2d.h);
    if (!d) return;
    var V = st.sec.view || (st.sec.view = fitView(d));
    var z = d.frame.p.z;

    // mriežka
    var step = niceStep(80 / V.s);
    var a0 = fromScr(V, 0, sec2d.h), a1 = fromScr(V, sec2d.w, 0);
    ctx.lineWidth = 1; ctx.font = "10px 'IBM Plex Mono', monospace";
    for (var u = Math.ceil(a0[0] / step) * step; u <= a1[0]; u += step) {
      var x = Math.round(toScr(V, u, 0)[0]) + 0.5;
      ctx.strokeStyle = Math.abs(u) < 1e-9 ? "#B9A9E3" : "#ECEAE3";
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, sec2d.h); ctx.stroke();
      ctx.fillStyle = "#98958A"; ctx.textAlign = "center";
      var ur = Math.round(u / step) * step;
      ctx.fillText((ur > 0 ? "+" : "") + fmt(ur || 0, step < 1 ? 1 : 0), x, sec2d.h - 6);
    }
    for (var v = Math.ceil(a0[1] / step) * step; v <= a1[1]; v += step) {
      var y = Math.round(toScr(V, 0, v)[1]) + 0.5;
      ctx.strokeStyle = "#ECEAE3";
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(sec2d.w, y); ctx.stroke();
      ctx.fillStyle = "#98958A"; ctx.textAlign = "left";
      ctx.fillText(fmt(Math.round(v / step) * step || 0, step < 1 ? 1 : 0), 6, y - 3);
    }

    // prvky
    var sel = st.sel;
    sec2d.paths = [];
    d.items.forEach(function (it) {
      var isSel = sel && sel.m === it.m && sel.id === it.id;
      var path = new Path2D();
      it.loops.forEach(function (L) {
        for (var i = 0; i < L.length; i += 2) {
          var p = toScr(V, L[i], L[i + 1]);
          if (i === 0) path.moveTo(p[0], p[1]); else path.lineTo(p[0], p[1]);
        }
        path.closePath();
      });
      ctx.fillStyle = isSel ? "rgba(242,169,0,.55)" : itemColor(it, 0.38);
      ctx.fill(path, "evenodd");
      ctx.strokeStyle = isSel ? "#9C6A00" : strokeColor(it);
      ctx.lineWidth = isSel ? 2 : 1.1;
      ctx.stroke(path);
      if (it.open.length) {
        var op = new Path2D();
        it.open.forEach(function (L) {
          for (var i = 0; i < L.length; i += 2) {
            var p = toScr(V, L[i], L[i + 1]);
            if (i === 0) op.moveTo(p[0], p[1]); else op.lineTo(p[0], p[1]);
          }
        });
        ctx.stroke(op);
      }
      sec2d.paths.push({ it: it, path: path });
    });

    // os trasy a niveleta
    var ax = toScr(V, 0, z);
    ctx.strokeStyle = "#D0216A"; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(Math.round(ax[0]) + 0.5, 0); ctx.lineTo(Math.round(ax[0]) + 0.5, sec2d.h); ctx.stroke();
    ctx.setLineDash([]);
    if (d.frame.p.hasZ) {
      ctx.fillStyle = "#D0216A";
      ctx.beginPath(); ctx.moveTo(ax[0], ax[1]); ctx.lineTo(ax[0] - 6, ax[1] - 10); ctx.lineTo(ax[0] + 6, ax[1] - 10); ctx.closePath(); ctx.fill();
      ctx.font = "600 11px 'IBM Plex Mono', monospace"; ctx.textAlign = "left";
      ctx.fillText(fmt(z, 3), ax[0] + 9, ax[1] - 4);
    }
    // ľavá / pravá strana
    ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.fillStyle = "#98958A";
    ctx.textAlign = "left"; ctx.fillText("◄ vľavo", 8, 16);
    ctx.textAlign = "right"; ctx.fillText("vpravo ►", sec2d.w - 8, 16);
    if (!d.items.length) {
      ctx.textAlign = "center"; ctx.fillStyle = "#5C5A52"; ctx.font = "12px 'IBM Plex Sans', sans-serif";
      ctx.fillText("V tomto staničení rez nepretína žiadny zobrazený prvok.", sec2d.w / 2, sec2d.h / 2 - 20);
    }
  }

  function secHit(x, y) {
    var ctx = sec2d.ctx;
    for (var i = sec2d.paths.length - 1; i >= 0; i--) {
      if (sec2d.paths[i].it.m.isTerrain) continue;
      if (ctx.isPointInPath(sec2d.paths[i].path, x * (sec2d.cv.width / sec2d.w), y * (sec2d.cv.height / sec2d.h), "evenodd")) return sec2d.paths[i].it;
    }
    // najbližšia čiara do 6 px
    var V = st.sec.view, best = null, bd = 6;
    if (!V || !st.sec.data) return null;
    st.sec.data.items.forEach(function (it) {
      if (it.m.isTerrain) return;
      for (var s = 0; s < it.segs.length; s += 4) {
        var a = toScr(V, it.segs[s], it.segs[s + 1]), b = toScr(V, it.segs[s + 2], it.segs[s + 3]);
        var dd = distSeg(x, y, a, b);
        if (dd < bd) { bd = dd; best = it; }
      }
    });
    return best;
  }
  function distSeg(x, y, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    var t = l ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)) : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  }

  function wireSecCanvas() {
    var cv = $("secCanvas"), drag = null;
    cv.addEventListener("wheel", function (e) {
      if (st.sec.mode === "long") { e.preventDefault(); profWheel(e); return; }
      if (!st.sec.view) return;
      e.preventDefault();
      var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, V = st.sec.view;
      var before = fromScr(V, x, y);
      V.s *= Math.pow(1.0015, -e.deltaY);
      var after = fromScr(V, x, y);
      V.cu += before[0] - after[0]; V.cv += before[1] - after[1];
      drawSection();
    }, { passive: false });
    cv.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", function (e) {
      if (st.sec.mode === "long") { profMove(e, drag); return; }
      var r = cv.getBoundingClientRect(), V = st.sec.view;
      if (V) {
        var w = fromScr(V, e.clientX - r.left, e.clientY - r.top);
        $("secCursor").textContent = "odsun " + (w[0] >= 0 ? "+" : "") + fmt(w[0], 3) + " m · výška " + fmt(w[1], 3) + " m";
      }
      if (!drag || !V) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      V.cu -= dx / V.s; V.cv += dy / V.s;
      drag.x = e.clientX; drag.y = e.clientY;
      drawSection();
    });
    cv.addEventListener("pointerup", function (e) {
      var r = cv.getBoundingClientRect();
      if (drag && !drag.moved && st.sec.mode === "long") profClick(e.clientX - r.left, e.clientY - r.top);
      else if (drag && !drag.moved) {
        var it = secHit(e.clientX - r.left, e.clientY - r.top);
        if (it) select(it.m, it.id); else select(null);
      }
      drag = null;
    });
    cv.addEventListener("pointerleave", function () { $("secCursor").textContent = ""; });
    cv.addEventListener("dblclick", function () {
      if (st.sec.mode === "long") st.sec.pview = null; else st.sec.view = null;
      drawSection();
    });
  }

  function renderSecInfo() {
    var d = st.sec.data, el = $("secInfo");
    if (!d) { el.innerHTML = ""; return; }
    var p = d.frame.p, a = st.sec.al.a;
    var H = { LINE: "priamka", CIRCULARARC: "kružnicový oblúk", CLOTHOID: "klotoida", CUBIC: "kubická parabola",
              BLOSSCURVE: "Blossova prechodnica", COSINECURVE: "kosínusová prechodnica", SINECURVE: "sínusová prechodnica",
              HELMERTCURVE: "Helmertova prechodnica", VIENNESEBEND: "Viedenský oblúk" };
    var Vt = { CONSTANTGRADIENT: "konštantný sklon", PARABOLICARC: "parabolický oblúk", CIRCULARARC: "kružnicový oblúk", CLOTHOID: "klotoida" };
    var rows = [
      ["staničenie", "km " + AL.formatStation(p.station)],
      ["X (projekt)", fmt(p.x, 3) + " m"],
      ["Y (projekt)", fmt(p.y, 3) + " m"],
      ["niveleta", p.hasZ ? fmt(p.z, 3) + " m" : "bez výškového vedenia"],
      ["pozdĺžny sklon", p.hasZ ? fmt(p.gradient * 100, 3) + " %" : "—"],
      ["smerový prvok", (H[p.hType] || p.hType.toLowerCase()) + (p.radius ? " · R " + fmt(Math.abs(p.radius), 1) + (p.radius > 0 ? " (vľavo)" : " (vpravo)") : "")],
      ["výškový prvok", p.hasZ ? (Vt[p.vType] || p.vType.toLowerCase()) + (p.vRadius && p.vType !== "CONSTANTGRADIENT" ? " · R " + fmt(Math.abs(p.vRadius), 0) : "") : "—"]
    ];
    if (p.cant) rows.push(["prevýšenie Ľ / P", fmt(p.cant.left * 1000, 1) + " / " + fmt(p.cant.right * 1000, 1) + " mm"]);
    if (st.sec.mode === "long") rows.push(["prvky v profile", String(st.sec.prof ? st.sec.prof.items.length : 0)]);
    else rows.push(["prvky v reze", String(d.items.length)]);
    el.innerHTML = rows.map(function (r) {
      return '<div class="si"><span class="si__k">' + esc(r[0]) + '</span><span class="si__v">' + esc(r[1]) + '</span></div>';
    }).join("") +
      (st.sec.mode === "long" ? verticalTable(a, p.dist) : "") +
      '<div class="si__note">' + esc(a.name || "trasa") + " · " + esc(st.sec.al.m.name) + "</div>";
  }

  // =========================================================================
  //  Pozdĺžny profil
  // =========================================================================
  /* Prepnutie medzi priečnym rezom a pozdĺžnym profilom. */
  function setMode(mode) {
    st.sec.mode = mode;
    var long = mode === "long";
    $("secModeX").classList.toggle("is-on", !long);
    $("secModeL").classList.toggle("is-on", long);
    $("secWidthL").hidden = long;
    $("secExagL").hidden = !long;
    $("secSerBox").hidden = long;
    $("secFit").textContent = long ? "celý profil" : "celý rez";
    $("secCursor").style.bottom = long ? (BAND + 24) + "px" : "";
    $("secSvg").textContent = long ? "profil do DXF ↓" : "rez do DXF ↓";
    document.querySelector("#mdSec .sec__tag").textContent = long ? "profil" : "rez";
    if (long && !st.sec.prof && st.sec.al) {
      busySec(true);
      setTimeout(function () { st.sec.prof = computeProfile(); busySec(false); drawSection(); renderSecInfo(); }, 20);
      return;
    }
    drawSection();
    renderSecInfo();
  }
  function busySec(on) {
    var ctx = sec2d.ctx; if (!ctx || !on) return;
    ctx.fillStyle = "rgba(252,252,250,.85)"; ctx.fillRect(0, 0, sec2d.w, sec2d.h);
    ctx.fillStyle = "#5C5A52"; ctx.font = "12px 'IBM Plex Mono', monospace"; ctx.textAlign = "center";
    ctx.fillText("počíta sa pozdĺžny profil…", sec2d.w / 2, sec2d.h / 2);
  }

  /* Prienik modelov s rozvinutou zvislou plochou pozdĺž osi trasy. Os sa zahustí
     na krátke úsečky; každá je zvislá rovina obmedzená na svoj úsek, takže
     susedné kúsky sa stretnú presne na zvislici cez bod osi a obrysy sa dajú
     pospájať. Výsledok: x = staničenie, y = výška (m). */
  function computeProfile() {
    var A = st.sec.al; if (!A) return null;
    var a = A.a, m0 = A.m;
    var pts = a.sample(Math.max(0.5, Math.min(5, a.length / 1500)));
    var W = pts.map(function (p) { return ifcToWorld(m0, p.x, p.y, p.z); });
    var items = [], bb = [Infinity, Infinity, -Infinity, -Infinity];

    cutModels().forEach(function (m) {
      if (!m.visible) return;
      var inv = m.group.matrixWorld.clone().invert();
      var L = W.map(function (w) { return w.clone().applyMatrix4(inv); });
      var up = new Lib.T.Vector3(0, 1, 0).transformDirection(inv);
      var ux = up.x, uy = up.y, uz = up.z;

      // mriežka prvkov v pôdoryse — na úsek osi sa testujú len prvky z jeho buniek
      var cell = Math.max(10, a.length / 300), grid = new Map(), big = [];
      var prods = [];
      m.products.forEach(function (p) { if (productShown(m, p)) prods.push(p); });
      prods.forEach(function (p, idx) {
        var i0 = Math.floor(p.bb[0] / cell), i1 = Math.floor(p.bb[3] / cell);
        var k0 = Math.floor(p.bb[2] / cell), k1 = Math.floor(p.bb[5] / cell);
        if ((i1 - i0 + 1) * (k1 - k0 + 1) > 400) { big.push(idx); return; }
        for (var i = i0; i <= i1; i++) for (var k = k0; k <= k1; k++) {
          var key2 = i + "," + k, l = grid.get(key2);
          if (l) l.push(idx); else grid.set(key2, [idx]);
        }
      });
      var segsOf = new Map(), stamp = new Int32Array(prods.length).fill(-1);

      for (var si = 0; si < L.length - 1; si++) {
        var A0 = L[si], A1 = L[si + 1];
        var dx = A1.x - A0.x, dz = A1.z - A0.z, len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        var tx = dx / len, tz = dz / len, nx = tz, nz = -tx;     // smer úseku a kolmica v pôdoryse
        var st0 = pts[si].station, dSt = pts[si + 1].station - st0, z0 = pts[si].z;
        var cand = big.slice();
        var ia = Math.floor(Math.min(A0.x, A1.x) / cell), ib = Math.floor(Math.max(A0.x, A1.x) / cell);
        var ka = Math.floor(Math.min(A0.z, A1.z) / cell), kb = Math.floor(Math.max(A0.z, A1.z) / cell);
        for (var ci = ia; ci <= ib; ci++) for (var ck = ka; ck <= kb; ck++) {
          var l2 = grid.get(ci + "," + ck); if (l2) for (var q = 0; q < l2.length; q++) cand.push(l2[q]);
        }
        for (var c = 0; c < cand.length; c++) {
          var pi = cand[c];
          if (stamp[pi] === si) continue;
          stamp[pi] = si;
          var p = prods[pi], b = p.bb;
          // obal prvku musí pretínať rovinu a zasahovať do dĺžky úseku
          var neg = false, pos = false, amin = Infinity, amax = -Infinity;
          for (var cc = 0; cc < 4; cc++) {
            var X = (cc & 1 ? b[3] : b[0]) - A0.x, Z = (cc & 2 ? b[5] : b[2]) - A0.z;
            var dn = X * nx + Z * nz, da = X * tx + Z * tz;
            if (dn < 0) neg = true; else pos = true;
            if (da < amin) amin = da; if (da > amax) amax = da;
          }
          if (!(neg && pos) || amax < (si === 0 ? -0.5 : 0) || amin > len + (si === L.length - 2 ? 0.5 : 0)) continue;
          var out = segsOf.get(p.id);
          // krajné úseky siahajú kúsok za koniec trasy — teselácia telies končí
          // o milimetre ďalej a ich čelá by inak vypadli (obrys by sa neuzavrel)
          var lo = si === 0 ? -0.5 : 0, hi = si === L.length - 2 ? len + 0.5 : len;
          cutProduct(p, A0, tx, tz, nx, nz, len, lo, hi, st0, dSt, z0, ux, uy, uz, function (x1, y1, x2, y2) {
            if (!out) { out = []; segsOf.set(p.id, out); }
            out.push(x1, y1, x2, y2);
          });
        }
      }
      segsOf.forEach(function (segs, id) {
        var prod = m.products.get(id);
        for (var i = 0; i < segs.length; i += 2) {
          if (segs[i] < bb[0]) bb[0] = segs[i]; if (segs[i] > bb[2]) bb[2] = segs[i];
          if (segs[i + 1] < bb[1]) bb[1] = segs[i + 1]; if (segs[i + 1] > bb[3]) bb[3] = segs[i + 1];
        }
        var ch = chain(segs);
        // prvok, ktorý pokračuje za začiatok či koniec trasy, je na hranici profilu
        // odrezaný — obrys s oboma koncami na tejto hranici sa uzavrie zvislou čiarou
        var edgeA = a.startStation - 0.5, edgeB = a.endStation + 0.5;
        var onEdge = function (x) { return Math.abs(x - edgeA) < 1e-4 || Math.abs(x - edgeB) < 1e-4; };
        // (terén je plocha, nie teleso — jeho čiara ostáva otvorená)
        if (!m.isTerrain) ch.open = ch.open.filter(function (Lp) {
          if (Lp.length >= 6 && onEdge(Lp[0]) && onEdge(Lp[Lp.length - 2])) { ch.loops.push(Lp); return false; }
          return true;
        });
        items.push({ m: m, id: id, cls: prod.cls, color: prod.color, segs: segs, loops: ch.loops, open: ch.open });
      });
    });

    var nivel = a.hasVertical ? pts.map(function (p) { return [p.station, p.z]; }) : [];
    var curv = pts.map(function (p) { return [p.station, p.radius ? 1 / p.radius : 0]; });
    nivel.forEach(function (n) { if (n[1] < bb[1]) bb[1] = n[1]; if (n[1] > bb[3]) bb[3] = n[1]; });
    return { items: items, bb: bb, nivel: nivel, curv: curv, a: a };
  }

  /* Prienik trojuholníkov jedného prvku so zvislou rovinou úseku osi. */
  function cutProduct(prod, A0, tx, tz, nx, nz, len, lo, hi, st0, dSt, z0, ux, uy, uz, emit) {
    var ax = A0.x, ay = A0.y, az = A0.z, k = dSt / len;
    prod.parts.forEach(function (pt) {
      var P = pt.ch.posA, I = pt.ch.idxA, end = pt.start + pt.count;
      for (var i = pt.start; i < end; i += 3) {
        var a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
        var da = (P[a] - ax) * nx + (P[a + 2] - az) * nz;
        var db = (P[b] - ax) * nx + (P[b + 2] - az) * nz;
        var dc = (P[c] - ax) * nx + (P[c + 2] - az) * nz;
        if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
        if (da === 0 && db === 0 && dc === 0) continue;
        var q = [];
        edge(a, da, b, db); edge(b, db, c, dc); edge(c, dc, a, da);
        if (q.length < 6) continue;
        // úsečka v rovine: s = vzdialenosť pozdĺž úseku, h = výška
        var s1 = (q[0] - ax) * tx + (q[2] - az) * tz, s2 = (q[3] - ax) * tx + (q[5] - az) * tz;
        var h1 = (q[0] - ax) * ux + (q[1] - ay) * uy + (q[2] - az) * uz + z0;
        var h2 = (q[3] - ax) * ux + (q[4] - ay) * uy + (q[5] - az) * uz + z0;
        // orezanie na dĺžku úseku — s toleranciou, aby čelá telies presne na
        // začiatku a konci trasy nevypadli pre zaokrúhľovaciu chybu
        var eps = 1e-6;
        if ((s1 < lo - eps && s2 < lo - eps) || (s1 > hi + eps && s2 > hi + eps)) continue;
        if (Math.abs(s2 - s1) <= eps) {
          s1 = s2 = Math.max(lo, Math.min(hi, (s1 + s2) / 2));
        } else {
          var t0 = 0, t1 = 1, ds = s2 - s1;
          var ta = (lo - s1) / ds, tb = (hi - s1) / ds;
          t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
          if (t0 >= t1) continue;
          var S1 = s1 + ds * t0, S2 = s1 + ds * t1, H1 = h1 + (h2 - h1) * t0, H2 = h1 + (h2 - h1) * t1;
          s1 = S1; s2 = S2; h1 = H1; h2 = H2;
        }
        emit(st0 + s1 * k, h1, st0 + s2 * k, h2);
      }
      function edge(i1, d1, i2, d2) {
        if (q.length >= 6) return;
        if (d1 === 0) { q.push(P[i1], P[i1 + 1], P[i1 + 2]); return; }
        if ((d1 < 0) === (d2 < 0) || d2 === 0) return;
        var t = d1 / (d1 - d2);
        q.push(P[i1] + (P[i2] - P[i1]) * t, P[i1 + 1] + (P[i2 + 1] - P[i1 + 1]) * t, P[i1 + 2] + (P[i2 + 2] - P[i1 + 2]) * t);
      }
    });
  }

  // ---- kreslenie profilu ----------------------------------------------------
  var BAND = 34;   // výška pásu smerových pomerov pod profilom (px)
  function profFit(pr) {
    var a = pr.a, bb = pr.bb, ex = st.sec.exag;
    var x0 = a.startStation, x1 = a.endStation;
    var y0 = isFinite(bb[1]) ? bb[1] : 0, y1 = isFinite(bb[3]) ? bb[3] : 10;
    if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
    var H = sec2d.h - BAND - 46;
    var sx = Math.min((sec2d.w - 80) / Math.max(x1 - x0, 1), H / ((y1 - y0) * ex));
    return { sx: sx, cs: (x0 + x1) / 2, cv: (y0 + y1) / 2 };
  }
  function pX(V, x) { return 50 + (sec2d.w - 60) / 2 + (x - V.cs) * V.sx; }
  function pY(V, y) { return 16 + (sec2d.h - BAND - 16) / 2 - (y - V.cv) * V.sx * st.sec.exag; }
  function pInv(V, X, Y) {
    return [(X - 50 - (sec2d.w - 60) / 2) / V.sx + V.cs, -(Y - 16 - (sec2d.h - BAND - 16) / 2) / (V.sx * st.sec.exag) + V.cv];
  }
  function stLabel(x, step) {
    return AL.formatStation(x, step < 1 ? 1 : 0).replace(/\.0$/, "");
  }

  function drawProfile() {
    var ctx = sec2d.ctx, pr = st.sec.prof, W = sec2d.w, H = sec2d.h;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#FCFCFA"; ctx.fillRect(0, 0, W, H);
    if (!pr) return;
    var V = st.sec.pview || (st.sec.pview = profFit(pr)), ex = st.sec.exag;
    var plotB = H - BAND;

    // mriežka: staničenia a výšky
    var xs = niceStep(90 / V.sx), ys = niceStep(46 / (V.sx * ex));
    var a0 = pInv(V, 0, plotB), a1 = pInv(V, W, 0);
    ctx.lineWidth = 1; ctx.font = "10px 'IBM Plex Mono', monospace";
    for (var x = Math.ceil(a0[0] / xs) * xs; x <= a1[0]; x += xs) {
      var X = Math.round(pX(V, x)) + 0.5;
      ctx.strokeStyle = "#ECEAE3"; ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, plotB); ctx.stroke();
      ctx.fillStyle = "#98958A"; ctx.textAlign = "center";
      ctx.fillText(stLabel(Math.round(x / xs) * xs, xs), X, plotB - 5);
    }
    for (var y = Math.ceil(a0[1] / ys) * ys; y <= a1[1]; y += ys) {
      var Y = Math.round(pY(V, y)) + 0.5;
      ctx.strokeStyle = "#ECEAE3"; ctx.beginPath(); ctx.moveTo(0, Y); ctx.lineTo(W, Y); ctx.stroke();
      ctx.fillStyle = "#98958A"; ctx.textAlign = "left";
      ctx.fillText(fmt(Math.round(y / ys) * ys || 0, ys < 1 ? 1 : 0), 6, Y - 3);
    }
    // začiatok a koniec trasy
    var a = pr.a;
    ctx.fillStyle = "rgba(237,235,228,.6)";
    var xa = pX(V, a.startStation), xb = pX(V, a.endStation);
    if (xa > 0) ctx.fillRect(0, 0, xa, plotB);
    if (xb < W) ctx.fillRect(xb, 0, W - xb, plotB);

    // prvky modelov
    var sel = st.sel;
    sec2d.paths = [];
    pr.items.forEach(function (it) {
      var isSel = sel && sel.m === it.m && sel.id === it.id;
      var path = new Path2D();
      it.loops.forEach(function (L) {
        for (var i = 0; i < L.length; i += 2) {
          var px = pX(V, L[i]), py = pY(V, L[i + 1]);
          if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
        }
        path.closePath();
      });
      ctx.fillStyle = isSel ? "rgba(242,169,0,.55)" : itemColor(it, 0.38);
      ctx.fill(path, "evenodd");
      ctx.strokeStyle = isSel ? "#9C6A00" : strokeColor(it);
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.stroke(path);
      if (it.open.length) {
        var op = new Path2D();
        it.open.forEach(function (L) {
          for (var i = 0; i < L.length; i += 2) {
            var px = pX(V, L[i]), py = pY(V, L[i + 1]);
            if (i === 0) op.moveTo(px, py); else op.lineTo(px, py);
          }
        });
        ctx.stroke(op);
      }
      sec2d.paths.push({ it: it, path: path });
    });

    // niveleta, lomy sklonu a popisy prvkov
    if (pr.nivel.length) {
      ctx.strokeStyle = "#D0216A"; ctx.lineWidth = 1.6; ctx.beginPath();
      pr.nivel.forEach(function (n, i) { var px = pX(V, n[0]), py = pY(V, n[1]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.stroke();
      ctx.lineWidth = 1;
      a.vertical.forEach(function (sg, i) {
        var s0 = a.startStation + sg.start, s1 = s0 + sg.length;
        var z0 = a.pointAt(sg.start).z, x0 = pX(V, s0), x1 = pX(V, s1);
        // hranica prvku
        ctx.fillStyle = "#D0216A";
        ctx.beginPath(); ctx.arc(x0, pY(V, z0), 2.5, 0, Math.PI * 2); ctx.fill();
        if (i === a.vertical.length - 1) { ctx.beginPath(); ctx.arc(x1, pY(V, a.pointAt(sg.start + sg.length).z), 2.5, 0, Math.PI * 2); ctx.fill(); }
        if (x1 - x0 < 70 || x1 < 0 || x0 > W) return;
        var mid = sg.start + sg.length / 2, zm = a.pointAt(mid).z;
        var label = sg.type === "CONSTANTGRADIENT" ? fmt(sg.g0 * 100, 2) + " %" :
          "R " + fmt(Math.abs(sg.r || 0), 0) + (sg.type === "PARABOLICARC" ? " (par.)" : "");
        ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.textAlign = "center";
        ctx.fillStyle = sg.type === "CONSTANTGRADIENT" ? "#A01B55" : "#4B3F8F";
        ctx.fillText(label, pX(V, a.startStation + mid), pY(V, zm) - 8);
      });
    } else {
      ctx.fillStyle = "#8A5A00"; ctx.font = "11px 'IBM Plex Sans', sans-serif"; ctx.textAlign = "left";
      ctx.fillText("Trasa nemá výškové vedenie (IfcAlignmentVertical) — zobrazujú sa len prieniky modelov.", 60, 34);
    }

    // aktuálne staničenie priečneho rezu
    var cx = Math.round(pX(V, st.sec.station)) + 0.5;
    ctx.strokeStyle = "#4B3F8F"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, plotB); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.textAlign = "center";
    var tag = "km " + AL.formatStation(st.sec.station, 2), tw = ctx.measureText(tag).width + 10;
    ctx.fillStyle = "#4B3F8F"; ctx.fillRect(cx - tw / 2, 2, tw, 15);
    ctx.fillStyle = "#fff"; ctx.fillText(tag, cx, 13);

    // pás smerových pomerov — krivosť (doľava hore, doprava dole)
    ctx.fillStyle = "#fff"; ctx.fillRect(0, plotB, W, BAND);
    ctx.strokeStyle = "#D3CFC4"; ctx.beginPath(); ctx.moveTo(0, plotB + 0.5); ctx.lineTo(W, plotB + 0.5); ctx.stroke();
    var mid0 = plotB + BAND / 2, kmax = 0;
    pr.curv.forEach(function (c) { kmax = Math.max(kmax, Math.abs(c[1])); });
    ctx.strokeStyle = "#ECEAE3"; ctx.beginPath(); ctx.moveTo(0, mid0 + 0.5); ctx.lineTo(W, mid0 + 0.5); ctx.stroke();
    if (kmax > 0) {
      ctx.strokeStyle = "#4B3F8F"; ctx.lineWidth = 1.3; ctx.beginPath();
      pr.curv.forEach(function (c, i) {
        var px = pX(V, c[0]), py = mid0 - c[1] / kmax * (BAND / 2 - 5);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.stroke(); ctx.lineWidth = 1;
    }
    ctx.fillStyle = "#98958A"; ctx.font = "9.5px 'IBM Plex Mono', monospace"; ctx.textAlign = "left";
    ctx.fillText("smerové pomery · ▲ vľavo  ▼ vpravo", 6, plotB + 11);
    ctx.textAlign = "right";
    ctx.fillText("prevýšenie " + ex + "×", W - 8, plotB + 11);
  }

  function profHit(x, y) {
    var ctx = sec2d.ctx, sx = sec2d.cv.width / sec2d.w, sy = sec2d.cv.height / sec2d.h;
    for (var i = sec2d.paths.length - 1; i >= 0; i--) {
      if (sec2d.paths[i].it.m.isTerrain) continue;
      if (ctx.isPointInPath(sec2d.paths[i].path, x * sx, y * sy, "evenodd")) return sec2d.paths[i].it;
    }
    return null;
  }
  function profClick(x, y) {
    var V = st.sec.pview; if (!V || !st.sec.prof) return;
    if (y < sec2d.h - BAND) {
      var it = profHit(x, y);
      if (it) select(it.m, it.id);
    }
    setStation(pInv(V, x, y)[0], { keepView: true });
  }
  function profWheel(e) {
    var V = st.sec.pview; if (!V) return;
    var r = sec2d.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    var b = pInv(V, x, y);
    V.sx *= Math.pow(1.0015, -e.deltaY);
    var c = pInv(V, x, y);
    V.cs += b[0] - c[0]; V.cv += b[1] - c[1];
    drawSection();
  }
  function profMove(e, drag) {
    var V = st.sec.pview; if (!V) return;
    var r = sec2d.cv.getBoundingClientRect(), w = pInv(V, e.clientX - r.left, e.clientY - r.top);
    var a = st.sec.al && st.sec.al.a, z = "";
    if (a && a.hasVertical && w[0] >= a.startStation && w[0] <= a.endStation) z = " · niveleta " + fmt(a.atStation(w[0]).z, 3) + " m";
    $("secCursor").textContent = "km " + AL.formatStation(w[0], 2) + " · výška " + fmt(w[1], 3) + " m" + z;
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    V.cs -= dx / V.sx; V.cv += dy / (V.sx * st.sec.exag);
    drag.x = e.clientX; drag.y = e.clientY;
    drawSection();
  }

  /* Tabuľka výškových prvkov (lomy nivelety) pre bočný panel profilu. */
  function verticalTable(a, dist) {
    if (!a.vertical.length) return '<div class="vt__h">výškové prvky</div><div class="dt__none">trasa nemá výškové vedenie</div>';
    var T = { CONSTANTGRADIENT: "sklon", PARABOLICARC: "parab.", CIRCULARARC: "oblúk", CLOTHOID: "klotoida" };
    var rows = a.vertical.map(function (sg) {
      var cur = dist >= sg.start - 1e-9 && dist <= sg.start + sg.length + 1e-9;
      var val = sg.type === "CONSTANTGRADIENT" ? fmt(sg.g0 * 100, 2) + " %" : "R " + fmt(Math.abs(sg.r || 0), 0);
      return "<tr" + (cur ? ' class="is-cur"' : "") + "><td>" + AL.formatStation(a.startStation + sg.start, 2) +
        "</td><td>" + (T[sg.type] || sg.type.toLowerCase()) + '</td><td class="r">' + val +
        '</td><td class="r">' + fmt(a.pointAt(sg.start).z, 3) + "</td></tr>";
    }).join("");
    return '<div class="vt__h">výškové prvky</div><table class="vt"><tr><th>začiatok km</th><th>prvok</th><th class="r">sklon / R</th><th class="r">výška</th></tr>' + rows + "</table>";
  }

  // ---- export do DXF ---------------------------------------------------------
  /* Jednoduchý zapisovač DXF R12 (AC1009) — ten načíta každý CAD (AutoCAD,
     BricsCAD, QCAD, LibreCAD…). Kreslí sa v metroch 1 : 1. Každá trieda IFC má
     vlastnú hladinu, obrysy prvkov sú uzavreté polyčiary. Súbor je v kódovej
     stránke Windows-1250 ($DWGCODEPAGE ANSI_1250) — tá pokryje slovenskú
     diakritiku a R12 inú ani nepozná. */
  function Dxf() { this.layers = new Map(); this.out = []; this.ext = [Infinity, Infinity, -Infinity, -Infinity]; }
  Dxf.prototype.layer = function (name, aci, dashed) {
    name = String(name).toUpperCase().replace(/[^A-Z0-9_$-]/g, "_").slice(0, 31) || "0";
    if (!this.layers.has(name)) this.layers.set(name, { aci: aci || 7, dashed: !!dashed });
    return name;
  };
  Dxf.prototype.grow = function (x, y) {
    var e = this.ext;
    if (x < e[0]) e[0] = x; if (y < e[1]) e[1] = y; if (x > e[2]) e[2] = x; if (y > e[3]) e[3] = y;
  };
  Dxf.prototype.line = function (ly, x1, y1, x2, y2) {
    this.out.push("0", "LINE", "8", ly, "10", n6(x1), "20", n6(y1), "30", "0", "11", n6(x2), "21", n6(y2), "31", "0");
    this.grow(x1, y1); this.grow(x2, y2);
  };
  Dxf.prototype.poly = function (ly, pts, closed, aci) {
    if (pts.length < 4) return;
    this.out.push("0", "POLYLINE", "8", ly);
    if (aci) this.out.push("62", String(aci));
    this.out.push("66", "1", "10", "0", "20", "0", "30", "0", "70", closed ? "1" : "0");
    for (var i = 0; i < pts.length; i += 2) {
      this.out.push("0", "VERTEX", "8", ly, "10", n6(pts[i]), "20", n6(pts[i + 1]), "30", "0");
      this.grow(pts[i], pts[i + 1]);
    }
    this.out.push("0", "SEQEND", "8", ly);
  };
  /* align: 0 vľavo, 1 na stred, 2 vpravo; rot v stupňoch */
  Dxf.prototype.text = function (ly, x, y, h, str, align, rot) {
    this.out.push("0", "TEXT", "8", ly, "10", n6(x), "20", n6(y), "30", "0", "40", n6(h), "1", dxfStr(str));
    if (rot) this.out.push("50", n6(rot));
    if (align) this.out.push("72", String(align), "11", n6(x), "21", n6(y), "31", "0");
    this.grow(x, y);
  };
  Dxf.prototype.bytes = function () {
    var e = this.ext, o = [];
    if (!isFinite(e[0])) e = [0, 0, 1, 1];
    o.push("0", "SECTION", "2", "HEADER",
      "9", "$ACADVER", "1", "AC1009",
      "9", "$DWGCODEPAGE", "3", "ANSI_1250",
      "9", "$EXTMIN", "10", n6(e[0]), "20", n6(e[1]), "30", "0",
      "9", "$EXTMAX", "10", n6(e[2]), "20", n6(e[3]), "30", "0",
      "0", "ENDSEC");
    o.push("0", "SECTION", "2", "TABLES");
    o.push("0", "TABLE", "2", "LTYPE", "70", "2",
      "0", "LTYPE", "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.0",
      "0", "LTYPE", "2", "DASHED", "70", "0", "3", "__ __ __", "72", "65", "73", "2", "40", "1.5", "49", "1.0", "49", "-0.5",
      "0", "ENDTAB");
    o.push("0", "TABLE", "2", "LAYER", "70", String(this.layers.size + 1),
      "0", "LAYER", "2", "0", "70", "0", "62", "7", "6", "CONTINUOUS");
    this.layers.forEach(function (l, name) {
      o.push("0", "LAYER", "2", name, "70", "0", "62", String(l.aci), "6", l.dashed ? "DASHED" : "CONTINUOUS");
    });
    o.push("0", "ENDTAB", "0", "ENDSEC");
    o.push("0", "SECTION", "2", "ENTITIES");
    o = o.concat(this.out);
    o.push("0", "ENDSEC", "0", "EOF");
    return cp1250(o.join("\r\n") + "\r\n");
  };
  function n6(x) { return (Math.round(x * 1e6) / 1e6).toString(); }
  // tvrdé medzery a typografické mínus z toLocaleString sú v CAD zbytočné
  function dxfStr(s) { return String(s).replace(/[\u00a0\u202f]/g, " ").replace(/\u2212/g, "-"); }
  var CP1250 = null;
  function cp1250(text) {
    if (!CP1250) {
      CP1250 = new Map();
      var dec = new TextDecoder("windows-1250");
      for (var b = 0x80; b <= 0xff; b++) CP1250.set(dec.decode(new Uint8Array([b])), b);
    }
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      out[i] = c < 0x80 ? c : (CP1250.get(text[i]) || 0x3f);   // znak mimo stránky → „?“
    }
    return out;
  }
  // najbližšia farba zo základnej palety AutoCADu (ACI)
  var ACI = [[1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255],
    [8, 128, 128, 128], [9, 192, 192, 192], [30, 255, 127, 0], [40, 255, 191, 0], [94, 0, 127, 0], [74, 127, 255, 0],
    [134, 0, 127, 127], [150, 0, 127, 255], [174, 0, 0, 127], [200, 127, 0, 255], [22, 165, 82, 0], [42, 165, 124, 0],
    [32, 255, 170, 127], [52, 255, 234, 127], [92, 127, 255, 127], [252, 166, 166, 166], [250, 51, 51, 51]];
  function aciOf(rgb) {
    var best = 7, bd = Infinity;
    ACI.forEach(function (c) {
      var d = (c[1] - rgb[0]) * (c[1] - rgb[0]) + (c[2] - rgb[1]) * (c[2] - rgb[1]) + (c[3] - rgb[2]) * (c[3] - rgb[2]);
      if (d < bd) { bd = d; best = c[0]; }
    });
    return best;
  }
  function itemRgb(it) {
    return st.colorMode === "model" ? hexRgb(it.m.color) : (it.color || [0.6, 0.6, 0.6]).map(function (x) { return x * 255; });
  }
  /* Obrysy prvkov rezu/profilu do DXF; tx, ty prevádzajú súradnice do výkresu. */
  function dxfItems(dx, items, tx, ty) {
    items.forEach(function (it) {
      var ly = dx.layer(prettyCls(it.cls).replace(/^Ifc/, "IFC_"), aciOf(itemRgb(it)));
      var map = function (L) { var o = []; for (var i = 0; i < L.length; i += 2) o.push(tx(L[i]), ty(L[i + 1])); return o; };
      it.loops.forEach(function (L) { dx.poly(ly, map(L), true); });
      it.open.forEach(function (L) { dx.poly(ly, map(L), false); });
    });
  }

  // ---- pozdĺžny profil do DXF ----------------------------------------------
  /* x = staničenie (m), y = (výška − porovnávacia rovina) × prevýšenie.
     Porovnávacia rovina (S. R.) je zaokrúhlená pod najnižší bod profilu. */
  function exportProfile() {
    var pr = st.sec.prof; if (!pr) return;
    var a = pr.a, ex = st.sec.exag, dx = new Dxf();
    var len = a.endStation - a.startStation;
    var y0 = isFinite(pr.bb[1]) ? pr.bb[1] : 0, y1 = isFinite(pr.bb[3]) ? pr.bb[3] : 10;
    var gs = niceStep((y1 - y0) / 8 || 1);
    var datum = Math.floor(y0 / gs) * gs - gs, top = Math.ceil(y1 / gs) * gs + gs;
    var X = function (x) { return x; }, Y = function (y) { return (y - datum) * ex; };
    var xs = niceStep(len / 20), th = Math.max(xs * 0.12, 0.2);       // výška písma v metroch výkresu
    var PH = (top - datum) * ex, band = PH * 0.12, x0 = a.startStation, x1 = a.endStation;
    var LG = dx.layer("MRIEZKA", 8), LT = dx.layer("POPIS", 7), LF = dx.layer("RAM", 8);

    // nad rámom stoja zvislé popisy lomov nivelety — nadpis ide až nad ne
    var tTop = PH + th * 24;
    dx.text(LT, x0, tTop + th * 2.5, th * 2, "Pozdĺžny profil — " + (a.name || "trasa"));
    dx.text(LT, x0, tTop, th, "prevýšenie " + ex + "× · S. R. " + fmt(datum, 2) + " m · km " +
      AL.formatStation(x0, 3) + " – " + AL.formatStation(x1, 3) + " · mini-ifc/tools");
    dx.poly(LF, [x0, 0, x1, 0, x1, PH, x0, PH], true);
    for (var x = Math.ceil(x0 / xs) * xs; x <= x1 + 1e-9; x += xs) {
      dx.line(LG, X(x), 0, X(x), PH);
      dx.text(LT, X(x), -band - th * 1.6, th, stLabel(Math.round(x / xs) * xs, xs), 1);
    }
    for (var y = datum; y <= top + 1e-9; y += gs) {
      dx.line(LG, x0, Y(y), x1, Y(y));
      dx.text(LT, x0 - th * 0.8, Y(y) - th / 2, th, fmt(Math.round(y / gs) * gs || 0, gs < 1 ? 1 : 0), 2);
    }
    dx.text(LT, x0 - th * 0.8, -band - th * 3.4, th * 0.8, "S. R. " + fmt(datum, 2), 2);

    dxfItems(dx, pr.items, X, Y);

    if (pr.nivel.length) {
      var LN = dx.layer("NIVELETA", 1), LL = dx.layer("NIVELETA_POPIS", 1), pts = [];
      pr.nivel.forEach(function (n) { pts.push(X(n[0]), Y(n[1])); });
      dx.poly(LN, pts, false);
      var bounds = a.vertical.map(function (sg) { return sg.start; });
      bounds.push(a.vertical[a.vertical.length - 1].start + a.vertical[a.vertical.length - 1].length);
      bounds.forEach(function (d) {
        var z = a.pointAt(d).z, xx = X(a.startStation + d);
        dx.line(LL, xx, 0, xx, Y(z));
        dx.text(LL, xx - th * 0.3, Y(z) + th, th * 0.8, "km " + AL.formatStation(a.startStation + d, 2) + "  " + fmt(z, 3), 0, 90);
      });
      a.vertical.forEach(function (sg) {
        if (sg.length < xs * 0.8) return;
        var mid = sg.start + sg.length / 2;
        dx.text(LL, X(a.startStation + mid), Y(a.pointAt(mid).z) + th * 0.8, th,
          sg.type === "CONSTANTGRADIENT" ? fmt(sg.g0 * 100, 2) + " %" : "R " + fmt(Math.abs(sg.r || 0), 0), 1);
      });
    }
    // pás smerových pomerov pod profilom
    var LS = dx.layer("SMEROVE_POMERY", 5), mid0 = -band / 2, kmax = 0;
    dx.poly(LF, [x0, -band, x1, -band, x1, 0, x0, 0], true);
    dx.line(LG, x0, mid0, x1, mid0);
    pr.curv.forEach(function (c) { kmax = Math.max(kmax, Math.abs(c[1])); });
    if (kmax > 0) {
      var cp = [];
      pr.curv.forEach(function (c) { cp.push(X(c[0]), mid0 + c[1] / kmax * band * 0.4); });
      dx.poly(LS, cp, false);
    }
    a.horizontal.forEach(function (h) {
      if (h.type === "LINE" || h.length < xs * 0.8) return;
      var R = h.type === "CIRCULARARC" ? "R " + fmt(Math.abs(h.r0), 0) : h.type.toLowerCase().replace("curve", "");
      dx.text(LS, X(a.startStation + h.start + h.length / 2), -band + th * 0.4, th * 0.8, R, 1);
    });
    dx.text(LT, x0 - th * 0.8, mid0 - th / 2, th * 0.8, "smer", 2);
    download("profil_" + safeName(a.name) + ".dxf", dx.bytes(), "application/dxf");
  }

  // ---- priečne rezy do DXF ---------------------------------------------------
  /* Jeden rez sa zapíše v skutočných súradniciach (x = odsun od osi, y = výška).
     Séria sa poukladá po dvoch vedľa seba; každý rez má vlastný rám a výšky
     sú v ňom popísané. */
  function dxfSections(list) {
    var dx = new Dxf(), a = st.sec.al.a, single = list.length === 1;
    var LG = dx.layer("MRIEZKA", 8), LT = dx.layer("POPIS", 7), LF = dx.layer("RAM", 8);
    var LA = dx.layer("OS_TRASY", 6, true), LN = dx.layer("NIVELETA", 1);
    var maxW = 1, maxH = 1;
    var B = list.map(function (d) { var V = fitBounds(d); maxW = Math.max(maxW, V.w); maxH = Math.max(maxH, V.h); return V; });
    var gs = niceStep(Math.max(maxW, maxH) / 12), th = Math.max(gs * 0.18, 0.08);
    var CW = maxW + gs * 3, CH = maxH + gs * 2 + th * 6, cols = single ? 1 : 2;
    var titleAt = [0, 0];
    list.forEach(function (d, i) {
      var V = B[i], z = d.frame.p.z;
      var vlo = Math.floor((V.cv - V.h / 2) / gs) * gs, vhi = Math.ceil((V.cv + V.h / 2) / gs) * gs;
      // v sérii majú všetky rámy rovnakú šírku — rezy sa dajú porovnávať pod sebou
      var half = Math.ceil((single ? V.w : maxW) / 2 / gs) * gs;
      // posun rámu vo výkrese; samostatný rez ostáva v skutočných výškach
      var ox = single ? 0 : (i % cols) * CW, oy = single ? 0 : -Math.floor(i / cols) * CH - vlo;
      var X = function (u) { return ox + u; }, Y = function (v) { return oy + v; };
      dx.poly(LF, [X(-half), Y(vlo), X(half), Y(vlo), X(half), Y(vhi), X(-half), Y(vhi)], true);
      if (i === 0) titleAt = [X(-half), Y(vhi)];
      dx.text(LT, X(-half), Y(vhi) + th * 1.2, th * 1.6, "km " + AL.formatStation(d.station));
      if (d.frame.p.hasZ) dx.text(LT, X(half), Y(vhi) + th * 1.2, th, "niveleta " + fmt(z, 3) + " · sklon " + fmt(d.frame.p.gradient * 100, 2) + " %", 2);
      for (var u = -half; u <= half + 1e-9; u += gs) {
        var ur = Math.round(u / gs) * gs || 0;
        dx.line(Math.abs(ur) < 1e-9 ? LA : LG, X(ur), Y(vlo), X(ur), Y(vhi));
        dx.text(LT, X(ur), Y(vlo) - th * 1.6, th * 0.8, (ur > 0 ? "+" : "") + fmt(ur, gs < 1 ? 1 : 0), 1);
      }
      for (var v = vlo; v <= vhi + 1e-9; v += gs) {
        dx.line(LG, X(-half), Y(v), X(half), Y(v));
        dx.text(LT, X(-half) - th * 0.5, Y(v) - th * 0.4, th * 0.8, fmt(Math.round(v / gs) * gs || 0, gs < 1 ? 1 : 0), 2);
      }
      dxfItems(dx, d.items, X, Y);
      if (d.frame.p.hasZ) {
        var s = th * 0.8;
        dx.poly(LN, [X(0), Y(z), X(-s / 2), Y(z) + s, X(s / 2), Y(z) + s], true);
        dx.text(LN, X(0) + s, Y(z) + s * 0.2, th * 0.9, fmt(z, 3));
      }
      dx.text(LT, X(-half), Y(vlo) - th * 3.4, th * 0.8, "vľavo");
      dx.text(LT, X(half), Y(vlo) - th * 3.4, th * 0.8, "vpravo", 2);
    });
    if (!single) dx.text(LT, titleAt[0], titleAt[1] + th * 4.5, th * 2.2,
      "Priečne rezy — " + (a.name || "trasa") + " · " + list.length + " " + plural(list.length, "rez", "rezy", "rezov"));
    return dx.bytes();
  }

  function fitBounds(d) {
    var bb = d.bb, z = d.frame.p.z;
    var u0 = isFinite(bb[0]) ? Math.min(bb[0], -1) : -10, u1 = isFinite(bb[2]) ? Math.max(bb[2], 1) : 10;
    var v0 = isFinite(bb[1]) ? Math.min(bb[1], z) : z - 5, v1 = isFinite(bb[3]) ? Math.max(bb[3], z) : z + 5;
    if (st.sec.width > 0) { u0 = -st.sec.width; u1 = st.sec.width; }
    // os trasy v strede rámu — rezy v sérii sa dajú porovnávať pod sebou
    var half = Math.max(Math.abs(u0), Math.abs(u1)) + 0.5;
    return { w: half * 2, h: (v1 - v0) * 1.1 + 1, cu: 0, cv: (v0 + v1) / 2 };
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function safeName(s) { return String(s || "trasa").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "trasa"; }

  function exportCurrent() {
    if (!st.sec.data) return;
    var a = st.sec.al.a;
    download("rez_" + safeName(a.name) + "_km" + AL.formatStation(st.sec.station).replace(/[,.]/g, "_") + ".dxf",
             dxfSections([st.sec.data]), "application/dxf");
  }
  function exportSeries() {
    var a = st.sec.al && st.sec.al.a; if (!a) return;
    var from = AL.parseStation($("secFrom").value), to = AL.parseStation($("secTo").value), step = +$("secEvery").value;
    var msg = $("secSerMsg");
    if (from == null || to == null || !(step > 0)) { msg.textContent = "Zadajte platné staničenie od – do a krok."; return; }
    if (to < from) { var t = from; from = to; to = t; }
    from = Math.max(from, a.startStation); to = Math.min(to, a.endStation);
    var list = [];
    for (var s = from; s <= to + 1e-6; s += step) list.push(s);
    if ($("secEnds").checked && list[list.length - 1] < to - 1e-6) list.push(to);
    if (list.length > 400) { msg.textContent = "Priveľa rezov (" + list.length + ") — zväčšite krok, najviac 400."; return; }
    if (!list.length) { msg.textContent = "Interval je mimo trasy."; return; }
    msg.textContent = "počíta sa " + list.length + " " + plural(list.length, "rez", "rezy", "rezov") + "…";
    setTimeout(function () {
      var data = list.map(function (s) { return computeSection(s); });
      download("rezy_" + safeName(a.name) + ".dxf", dxfSections(data), "application/dxf");
      msg.textContent = "Hotovo — " + list.length + " " + plural(list.length, "rez", "rezy", "rezov") + " v jednom DXF.";
    }, 30);
  }


  // =========================================================================
  //  Terén a mapové podklady
  // =========================================================================
  var G = window.IFCGeo;
  var PROJ4_URL = "https://cdn.jsdelivr.net/npm/proj4@2.20.9/dist/proj4.js";
  var proj4P = null;
  function loadProj4() {
    if (proj4P) return proj4P;
    proj4P = new Promise(function (res, rej) {
      if (window.proj4) { G.useProj4(window.proj4); res(); return; }
      var sc = document.createElement("script");
      sc.src = PROJ4_URL;
      sc.onload = function () { G.useProj4(window.proj4); res(); };
      sc.onerror = function () { proj4P = null; rej(new Error("knižnicu proj4 sa nepodarilo stiahnuť")); };
      document.head.appendChild(sc);
    });
    return proj4P;
  }

  /* Súradnice sveta (scéna, Y hore) → súradnice projektu IFC (m, Z hore). */
  function worldToIfc(m, v) {
    var M = m.group.matrixWorld.clone().multiply(m.Mi).invert();
    var p = v.clone().applyMatrix4(M);
    return [p.x, -p.z, p.y];
  }

  /* Poloha z načítaných modelov: IfcMapConversion so známym systémom, inak
     súradnice priamo v S-JTSK. Ručne zadanú polohu nové modely neprepíšu. */
  function detectGeoref() {
    if (st.geo.manual || !G) return;
    st.geo.georef = null; st.geo.note = "";
    for (var i = 0; i < st.models.length; i++) {
      var m = st.models[i], mc = m.map;
      if (!mc) continue;
      var code = G.crsCode(mc.crs, mc.crsDesc);
      // bez mena systému, ale posun leží v S-JTSK — v Česku a na Slovensku obvyklé
      if (!code && G.looksLikeJtsk(mc.e, mc.n, mc.e, mc.n)) code = "EPSG:5514";
      if (code && G.supported(code)) {
        st.geo.georef = G.makeGeoref({ crs: code, e0: mc.e, n0: mc.n, h0: mc.h, ax: mc.ax, ay: mc.ay, scale: mc.scale, source: "mapconv" });
        st.geo.note = "IfcMapConversion v " + m.name;
        return;
      }
      st.geo.note = "IfcMapConversion v " + m.name + " používa systém „" + (mc.crs || "neuvedený") + "“, ktorý nástroj nepozná — zadajte polohu ručne.";
    }
    if (!st.models.length) return;
    var b = projectBox();
    if (b && G.looksLikeJtsk(b[0], b[1], b[2], b[3])) {
      st.geo.georef = G.makeGeoref({ crs: "EPSG:5514", source: "direct" });
      st.geo.note = "súradnice modelu ležia priamo v S-JTSK";
    }
  }

  /* Obdĺžnik zobrazených modelov v súradniciach projektu [minX, minY, maxX, maxY, minZ, maxZ]. */
  function projectBox() {
    var box = visibleBox(); if (box.isEmpty() || !st.models.length) return null;
    var m = st.models[0], T = Lib.T, out = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];
    for (var c = 0; c < 8; c++) {
      var p = worldToIfc(m, new T.Vector3(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z));
      out[0] = Math.min(out[0], p[0]); out[1] = Math.min(out[1], p[1]); out[2] = Math.max(out[2], p[0]); out[3] = Math.max(out[3], p[1]);
      out[4] = Math.min(out[4], p[2]); out[5] = Math.max(out[5], p[2]);
    }
    return out;
  }

  function loadImg(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.crossOrigin = "anonymous";     // bez CORS by sa obrázok nedal použiť ako textúra
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error("obrázok sa nenačítal")); };
      im.src = url;
    });
  }

  /* Mozaika dlaždíc XYZ pokrývajúca obdĺžnik v EPSG:3857. */
  function xyzMosaic(src, minX, minY, maxX, maxY, maxTiles) {
    var z = G.zoomFor(minX, minY, maxX, maxY, src.maxZoom || 18, maxTiles);
    var a = G.mercToTile(minX, maxY, z), b = G.mercToTile(maxX, minY, z);
    var tx0 = Math.floor(a[0] / 256), ty0 = Math.floor(a[1] / 256), tx1 = Math.floor(b[0] / 256), ty1 = Math.floor(b[1] / 256);
    var cv = document.createElement("canvas");
    cv.width = (tx1 - tx0 + 1) * 256; cv.height = (ty1 - ty0 + 1) * 256;
    var ctx = cv.getContext("2d"), jobs = [], fails = 0;
    for (var tx = tx0; tx <= tx1; tx++) for (var ty = ty0; ty <= ty1; ty++) (function (tx, ty) {
      var url = src.url.replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
      jobs.push(loadImg(url).then(function (im) { ctx.drawImage(im, (tx - tx0) * 256, (ty - ty0) * 256); }, function () { fails++; }));
    })(tx, ty);
    return Promise.all(jobs).then(function () {
      if (fails === jobs.length) throw new Error(src.label + ": dlaždice sa nenačítali");
      return { canvas: cv, z: z, px0: tx0 * 256, py0: ty0 * 256 };
    });
  }

  var capsCache = {};
  function wmsLayers(src) {
    if (capsCache[src.url]) return capsCache[src.url];
    capsCache[src.url] = fetch(G.wmsCapsUrl(src)).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (t) {
      var caps = G.parseCaps(new DOMParser().parseFromString(t, "text/xml"));
      if (!caps.layers.length) throw new Error("služba neuvádza vrstvy");
      // niektoré služby ArcGIS uvádzajú S-JTSK len ako ESRI:102067
      var crs = caps.crs.indexOf("EPSG:5514") >= 0 || !caps.crs.length ? "EPSG:5514" :
        caps.crs.indexOf("EPSG:102067") >= 0 ? "EPSG:102067" : "EPSG:5514";
      return { layers: caps.layers, crs: crs };
    });
    capsCache[src.url].catch(function () { delete capsCache[src.url]; });
    return capsCache[src.url];
  }

  function setGeoStatus(text, attr) {
    st.geo.status = text || ""; if (attr !== undefined) st.geo.attr = attr;
    var el = $("mdGeoStatus"); if (el) el.textContent = st.geo.status;
    var at = $("mdGeoAttr"); if (at) at.textContent = st.geo.attr;
  }

  function removeTerrain() {
    if (st.geo.mesh) {
      three.scene.remove(st.geo.mesh);
      st.geo.mesh.geometry.dispose();
      if (st.geo.mesh.material.map) st.geo.mesh.material.map.dispose();
      st.geo.mesh.material.dispose();
    }
    st.geo.mesh = null; st.geo.model = null;
    st.sec.prof = null;
    refreshSection();
    requestRender();
  }

  /* Terén okolo modelov: pravidelná sieť v súradniciach projektu, výšky
     z výškového modelu, na ňom mapa. Každý vrchol sa prevedie do systému
     podkladu, takže mapa sedí aj pri inom systéme modelu než má služba. */
  function buildTerrain() {
    var g = st.geo, o = g.opt, T = Lib.T;
    if (g.busy) return;
    if (!g.georef) { setGeoStatus("Poloha modelu nie je známa — zadajte ju ručne."); return; }
    var b = projectBox(); if (!b) return;
    g.busy = true; renderGeo();
    setGeoStatus("sťahuje sa knižnica na prevod súradníc…", "");
    loadProj4().then(function () {
      var gr = g.georef;
      var x0 = b[0] - o.margin, y0 = b[1] - o.margin, x1 = b[2] + o.margin, y1 = b[3] + o.margin;
      var span = Math.max(x1 - x0, y1 - y0), step = Math.max(1, span / 180);
      var nx = Math.max(2, Math.ceil((x1 - x0) / step) + 1), ny = Math.max(2, Math.ceil((y1 - y0) / step) + 1);
      var n = nx * ny, xs = new Float64Array(n), ys = new Float64Array(n);
      var E = new Float64Array(n), N = new Float64Array(n), lon = new Float64Array(n), lat = new Float64Array(n);
      for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
        var k = j * nx + i, x = x0 + (x1 - x0) * i / (nx - 1), y = y0 + (y1 - y0) * j / (ny - 1);
        xs[k] = x; ys[k] = y;
        var mp = gr.toMap(x, y, 0); E[k] = mp[0]; N[k] = mp[1];
        var ll = G.transform(gr.crs, "EPSG:4326", [mp[0], mp[1]]); lon[k] = ll[0]; lat[k] = ll[1];
      }
      var c = (ny >> 1) * nx + (nx >> 1);
      var land = o.country === "auto" ? (G.country(lon[c], lat[c]) || "CZ") : o.country;
      var job = { nx: nx, ny: ny, n: n, xs: xs, ys: ys, E: E, N: N, lon: lon, lat: lat, land: land,
                  H: null, uv: null, tex: null, notes: [], attr: [] };
      setGeoStatus("načítava sa výškový model…");
      return terrainHeights(job).then(function () {
        setGeoStatus("načítava sa mapa…");
        return terrainImage(job);
      }).then(function () { makeTerrainMesh(job, b); });
    }).catch(function (e) {
      setGeoStatus("Terén sa nepodarilo vytvoriť: " + (e && e.message ? e.message : e));
    }).then(function () { g.busy = false; renderGeo(); });
  }

  function terrainHeights(job) {
    var g = st.geo;
    if (g.opt.terrain !== "dem") return Promise.resolve();
    var src = G.SOURCES.terrarium.any;
    var mx = new Float64Array(job.n), my = new Float64Array(job.n), b = [Infinity, Infinity, -Infinity, -Infinity];
    for (var k = 0; k < job.n; k++) {
      var p = G.transform("EPSG:4326", "EPSG:3857", [job.lon[k], job.lat[k]]); mx[k] = p[0]; my[k] = p[1];
      b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
    }
    return xyzMosaic(src, b[0], b[1], b[2], b[3], 36).then(function (mo) {
      var W = mo.canvas.width, H = mo.canvas.height;
      var data = mo.canvas.getContext("2d").getImageData(0, 0, W, H).data;
      var px = function (x, y) {
        x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
        var o = (y * W + x) * 4;
        return G.terrariumHeight(data[o], data[o + 1], data[o + 2]);
      };
      job.H = new Float64Array(job.n);
      for (var k = 0; k < job.n; k++) {
        var t = G.mercToTile(mx[k], my[k], mo.z), u = t[0] - mo.px0 - 0.5, v = t[1] - mo.py0 - 0.5;
        var i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
        job.H[k] = px(i, j) * (1 - fu) * (1 - fv) + px(i + 1, j) * fu * (1 - fv) + px(i, j + 1) * (1 - fu) * fv + px(i + 1, j + 1) * fu * fv;
      }
      job.attr.push("výšky: " + src.attr);
      job.notes.push("výškový model " + src.label + " · zoom " + mo.z);
    }).catch(function (e) {
      job.H = null;
      job.notes.push("výškový model nedostupný (" + e.message + ") — terén je rovina");
    });
  }

  function terrainImage(job) {
    var o = st.geo.opt;
    if (o.base === "none") return Promise.resolve();
    var src = o.base === "osm" ? G.SOURCES.osm.any : (G.SOURCES[o.base] || {})[job.land];
    if (!src) return Promise.resolve();
    var gr = st.geo.georef, uv = new Float32Array(job.n * 2);
    if (src.kind === "wms") {
      return wmsLayers(src).then(function (caps) {
        // vrcholy v S-JTSK — mapa sa pýta priamo v ňom
        var e = new Float64Array(job.n), nn = new Float64Array(job.n), b = [Infinity, Infinity, -Infinity, -Infinity];
        for (var k = 0; k < job.n; k++) {
          var p = gr.crs === "EPSG:5514" ? [job.E[k], job.N[k]] : G.transform(gr.crs, "EPSG:5514", [job.E[k], job.N[k]]);
          e[k] = p[0]; nn[k] = p[1];
          b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
        }
        var dE = b[2] - b[0], dN = b[3] - b[1], max = 2048;
        var w = dE >= dN ? max : Math.max(64, Math.round(max * dE / dN)), h = dE >= dN ? Math.max(64, Math.round(max * dN / dE)) : max;
        return loadImg(G.wmsGetMap(src, caps.layers, caps.crs, b, w, h)).then(function (im) {
          for (var k = 0; k < job.n; k++) { uv[k * 2] = (e[k] - b[0]) / dE; uv[k * 2 + 1] = (nn[k] - b[1]) / dN; }
          job.tex = im; job.uv = uv; job.attr.push("mapa: " + src.label + " " + src.attr);
        });
      }).catch(function (e) {
        job.notes.push(src.label + " nedostupná (" + e.message + "; služba nemusí povoľovať CORS)");
      });
    }
    var mx = new Float64Array(job.n), my = new Float64Array(job.n), b = [Infinity, Infinity, -Infinity, -Infinity];
    for (var k = 0; k < job.n; k++) {
      var p = G.transform("EPSG:4326", "EPSG:3857", [job.lon[k], job.lat[k]]); mx[k] = p[0]; my[k] = p[1];
      b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
    }
    return xyzMosaic(src, b[0], b[1], b[2], b[3], 48).then(function (mo) {
      for (var k = 0; k < job.n; k++) {
        var t = G.mercToTile(mx[k], my[k], mo.z);
        uv[k * 2] = (t[0] - mo.px0) / mo.canvas.width; uv[k * 2 + 1] = 1 - (t[1] - mo.py0) / mo.canvas.height;
      }
      job.tex = mo.canvas; job.uv = uv; job.attr.push("mapa: " + src.attr);
    }).catch(function (e) { job.notes.push(src.label + " nedostupná (" + e.message + ")"); });
  }

  function makeTerrainMesh(job, b) {
    var T = Lib.T, gr = st.geo.georef, base = st.models[0];
    var pos = new Float32Array(job.n * 3);
    var flat = b[4] - 0.05;                       // bez výšok: rovina tesne pod modelom
    var bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (var k = 0; k < job.n; k++) {
      var z = job.H ? gr.toLocal(job.E[k], job.N[k], job.H[k])[2] : flat;
      var v = ifcToWorld(base, job.xs[k], job.ys[k], z);
      pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
      bb[0] = Math.min(bb[0], v.x); bb[1] = Math.min(bb[1], v.y); bb[2] = Math.min(bb[2], v.z);
      bb[3] = Math.max(bb[3], v.x); bb[4] = Math.max(bb[4], v.y); bb[5] = Math.max(bb[5], v.z);
    }
    var idx = new Uint32Array((job.nx - 1) * (job.ny - 1) * 6), q = 0;
    for (var j = 0; j < job.ny - 1; j++) for (var i = 0; i < job.nx - 1; i++) {
      var a = j * job.nx + i, c = a + job.nx;
      idx[q++] = a; idx[q++] = a + 1; idx[q++] = c; idx[q++] = a + 1; idx[q++] = c + 1; idx[q++] = c;
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    geo.setIndex(new T.BufferAttribute(idx, 1));
    if (job.uv) geo.setAttribute("uv", new T.BufferAttribute(job.uv, 2));
    geo.computeVertexNormals();
    var map = null;
    if (job.tex) {
      map = job.tex.tagName === "CANVAS" ? new T.CanvasTexture(job.tex) : new T.Texture(job.tex);
      map.colorSpace = T.SRGBColorSpace; map.anisotropy = 4; map.needsUpdate = true;
    }
    var mat = new T.MeshLambertMaterial({ map: map, color: map ? 0xffffff : 0xCFC8B6, side: T.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 });
    if (st.geo.mesh) removeTerrain();
    var mesh = new T.Mesh(geo, mat);
    mesh.renderOrder = -1;
    three.scene.add(mesh);
    st.geo.mesh = mesh;
    // terén ako „model“ pre rezy a profil — prieniky sa počítajú rovnako ako pri IFC
    var prod = { id: 1, cls: "TEREN", parts: [{ ch: { posA: pos, idxA: idx }, start: 0, count: idx.length }], bb: bb, color: [0.55, 0.42, 0.26, 1] };
    st.geo.model = { uid: 0, name: "terén", color: "#8C6B42", visible: true, isTerrain: true,
      group: { matrixWorld: new T.Matrix4() }, products: new Map([[1, prod]]), classes: new Map() };
    applyMaterials();
    st.sec.prof = null;
    refreshSection();
    setGeoStatus((job.H ? "Terén je hotový" : "Plocha je hotová") + " — " + job.nx + " × " + job.ny + " bodov, " +
      (job.land === "SK" ? "Slovensko" : "Česko") + ". " + job.notes.join(" · "), job.attr.join(" · "));
  }

  // ---- panel „terén a mapa“ ----------------------------------------------------
  function renderGeo() {
    var g = st.geo, o = g.opt, el = $("mdGeoBody"); if (!el) return;
    var gr = g.georef;
    var where = gr ? esc(G.CRS_LABEL[gr.crs] || gr.crs) + ' <span class="mg__src">· ' + esc(g.manual ? "zadané ručne" : g.note) + "</span>" :
      '<span class="mg__bad">' + esc(g.note || "Poloha modelu nie je známa — model nemá IfcMapConversion a nie je v S-JTSK.") + "</span>";
    var sel = function (id, cur, opts) {
      return '<select id="' + id + '">' + opts.map(function (x) {
        return '<option value="' + x[0] + '"' + (String(cur) === String(x[0]) ? " selected" : "") + ">" + esc(x[1]) + "</option>";
      }).join("") + "</select>";
    };
    var m0 = gr || { crs: "EPSG:5514", e0: 0, n0: 0, h0: 0, rotationDeg: 0 };
    el.innerHTML =
      '<div class="pop__sub">poloha modelu</div><div class="mg__where">' + where + "</div>" +
      '<details class="mg__man"' + (!gr ? " open" : "") + "><summary>zadať polohu ručne</summary>" +
        '<div class="mg__grid">' +
          '<label>systém ' + sel("mgCrs", m0.crs, Object.keys(G.CRS_LABEL).map(function (k) { return [k, G.CRS_LABEL[k]]; })) + "</label>" +
          '<label>E počiatku <input id="mgE" type="number" step="0.001" value="' + m0.e0 + '"></label>' +
          '<label>N počiatku <input id="mgN" type="number" step="0.001" value="' + m0.n0 + '"></label>' +
          '<label>výška počiatku <input id="mgH" type="number" step="0.001" value="' + m0.h0 + '"></label>' +
          '<label>natočenie osi X (°) <input id="mgR" type="number" step="0.0001" value="' + (+m0.rotationDeg.toFixed(6)) + '"></label>' +
        "</div>" +
        '<div class="mg__row"><button class="minibtn" id="mgApply">použiť</button>' +
        (g.manual ? '<button class="linkbtn" id="mgAuto">zistiť z modelu</button>' : "") + "</div>" +
        '<div class="help">Bod 0,0,0 súradníc modelu v zvolenom systéme. Pre S-JTSK zadajte záporné súradnice (napr. E −598 000, N −1 160 000).</div>' +
      "</details>" +
      '<div class="pop__sub">podklad</div>' +
      '<div class="mg__grid">' +
        "<label>mapa " + sel("mgBase", o.base, [["ortofoto", "ortofotomapa (ČÚZK / ZBGIS)"], ["mapa", "základná mapa (ZTM / ZBGIS)"], ["osm", "OpenStreetMap"], ["none", "bez mapy"]]) + "</label>" +
        "<label>krajina " + sel("mgLand", o.country, [["auto", "podľa polohy"], ["CZ", "Česko — ČÚZK"], ["SK", "Slovensko — GKÚ"]]) + "</label>" +
        "<label>terén " + sel("mgTer", o.terrain, [["dem", "výškový model"], ["flat", "rovina pod modelom"]]) + "</label>" +
        "<label>oblasť " + sel("mgMargin", o.margin, [[100, "±100 m okolo modelov"], [250, "±250 m"], [500, "±500 m"], [1000, "±1 km"], [2000, "±2 km"]]) + "</label>" +
        '<label>priehľadnosť <input id="mgOp" type="range" min="0.2" max="1" step="0.05" value="' + o.opacity + '"></label>' +
      "</div>" +
      '<div class="mg__row"><button class="btn btn--sm" id="mgGo"' + (g.busy || !gr ? " disabled" : "") + ">" +
        (g.busy ? "načítava sa…" : g.mesh ? "obnoviť terén" : "načítať terén a mapu") + "</button>" +
        (g.mesh ? '<label class="radio radio--flat"><input type="checkbox" id="mgShow"' + (g.mesh.visible ? " checked" : "") + '><span>zobraziť</span></label>' +
                  '<button class="linkbtn" id="mgDel">odstrániť</button>' : "") + "</div>" +
      '<div class="mg__status" id="mdGeoStatus">' + esc(g.status) + "</div>" +
      '<div class="mg__attr" id="mdGeoAttr">' + esc(g.attr) + "</div>";
    $("mdGeoBtn").classList.toggle("is-on", !!(g.mesh && g.mesh.visible));
  }

  function wireGeo() {
    var body = $("mdGeoBody");
    body.addEventListener("click", function (e) {
      var id = e.target.id;
      if (id === "mgGo") buildTerrain();
      else if (id === "mgDel") { removeTerrain(); setGeoStatus("", ""); renderGeo(); }
      else if (id === "mgAuto") { st.geo.manual = false; detectGeoref(); renderGeo(); }
      else if (id === "mgApply") {
        var r = (+$("mgR").value || 0) * Math.PI / 180;
        st.geo.georef = G.makeGeoref({ crs: $("mgCrs").value, e0: +$("mgE").value, n0: +$("mgN").value, h0: +$("mgH").value,
          ax: Math.cos(r), ay: Math.sin(r), source: "manual" });
        st.geo.manual = true;
        setGeoStatus("Poloha nastavená — načítajte terén.");
        renderGeo();
      }
    });
    body.addEventListener("change", function (e) {
      var o = st.geo.opt, id = e.target.id;
      if (id === "mgBase") o.base = e.target.value;
      else if (id === "mgLand") o.country = e.target.value;
      else if (id === "mgTer") o.terrain = e.target.value;
      else if (id === "mgMargin") o.margin = +e.target.value;
      else if (id === "mgShow") {
        st.geo.mesh.visible = e.target.checked;
        st.sec.prof = null; refreshSection(); renderGeo(); requestRender();
      }
    });
    body.addEventListener("input", function (e) {
      if (e.target.id === "mgOp") { st.geo.opt.opacity = +e.target.value; applyMaterials(); }
    });
    $("mdGeo").addEventListener("toggle", function () { if (this.open) renderGeo(); });
    document.addEventListener("click", function (e) {
      var d = $("mdGeo");
      if (d.open && !d.contains(e.target)) d.open = false;
    });
  }

  // =========================================================================
  //  Rozhranie
  // =========================================================================
  var UPLOAD_ICON = '<svg class="drop__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4m0 0L7 9m5-5l5 5"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/></svg>';

  function renderDrop(err) {
    $("mdPanel").hidden = false;
    $("mdPanel").classList.toggle("is-error", !!err);
    $("mdTitle").textContent = err ? "súbor sa nepodarilo načítať" : "nahrajte jeden alebo viac IFC";
    $("mdBody").innerHTML =
      (err ? '<div class="note note--bad" style="margin-bottom:12px"><span class="note__i">✕</span><span>' + esc(err) + "</span></div>" : "") +
      '<div class="drop drop--tall" id="mdDrop">' + UPLOAD_ICON +
        '<div class="drop__main">presuňte sem .ifc — aj viac naraz</div>' +
        '<div class="drop__hint">alebo kliknite pre výber · modely sa zobrazia spolu na koordináciu</div>' +
      "</div>";
    var dz = $("mdDrop");
    dz.addEventListener("click", function () { $("fileM").click(); });
    wireDrop(dz);
  }
  function wireDrop(el) {
    el.addEventListener("dragover", function (e) { e.preventDefault(); el.classList.add("is-over"); });
    el.addEventListener("dragleave", function () { el.classList.remove("is-over"); });
    el.addEventListener("drop", function (e) {
      e.preventDefault(); el.classList.remove("is-over");
      if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
  }

  function busy(text) {
    var b = $("mdBusy");
    if (!text) { b.hidden = true; return; }
    b.hidden = false;
    b.querySelector(".md__busyT").textContent = text;
  }

  function addFiles(list) {
    var files = Array.prototype.slice.call(list).filter(function (f) { return /\.ifc$/i.test(f.name); });
    if (!files.length) { if (!st.models.length) renderDrop("Vyberte súbory s príponou .ifc."); return; }
    if (st.busy) return;
    st.busy = true;
    var first = !st.models.length;
    if (first) {
      $("mdBody").innerHTML = '<div class="drop drop--busy drop--tall"><div class="spinner"></div>' +
        '<div class="drop__main">načítava sa prehliadač…</div><div class="drop__hint">three.js + web-ifc (WebAssembly), prvýkrát niekoľko sekúnd</div></div>';
    }
    loadLibs().then(function () {
      $("mdPanel").hidden = true;
      $("mdApp").hidden = false;
      initScene();
      resize();
      var errs = [], i = 0;
      function nextFile() {
        if (i >= files.length) return Promise.resolve();
        var f = files[i++];
        busy("načítava sa " + f.name + (files.length > 1 ? " (" + i + "/" + files.length + ")" : "") + "…");
        return new Promise(function (r) { setTimeout(r, 30); }).then(function () {
          return loadModel(f, function (t) { busy(f.name + " — " + t); });
        }).then(function (m) {
          st.models.push(m);
        }, function (e) {
          errs.push(f.name + ": " + (e && e.message ? e.message : String(e)));
        }).then(nextFile);
      }
      return nextFile().then(function () {
        busy(null);
        if (!st.models.length) {
          $("mdApp").hidden = true;
          renderDrop(errs.join(" · ") || "Súbor neobsahuje zobraziteľnú geometriu.");
          return;
        }
        $("mdErr").hidden = !errs.length;
        $("mdErr").innerHTML = errs.length ? '<span class="note__i">✕</span><span>' + esc(errs.join(" · ")) + "</span>" : "";
        rebuildIndices();
        applyMaterials();
        if (first) focusBox(visibleBox(), new Lib.T.Vector3(1, 0.8, 1));
        detectGeoref();
        renderGeo();
        renderAll();
        // prvá trasa → hneď pripraviť rezy
        if (!st.sec.al) {
          for (var k = 0; k < st.models.length; k++) if (st.models[k].alignments.length) { openSection(st.models[k], st.models[k].alignments[0]); break; }
        }
      });
    }).catch(function (e) {
      busy(null);
      console.error(e);
      if (!st.models.length) {
        $("mdApp").hidden = true;
        renderDrop("Prehliadač sa nepodarilo spustiť: " + (e && e.message ? e.message : e) + ". Skontrolujte pripojenie na internet (knižnice sa sťahujú z cdn.jsdelivr.net).");
      }
    }).then(function () { st.busy = false; });
  }

  function removeModel(m) {
    var i = st.models.indexOf(m); if (i < 0) return;
    if (st.sel && st.sel.m === m) select(null);
    if (st.sec.al && st.sec.al.m === m) closeSection();
    three.scene.remove(m.group);
    m.group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
      if (o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
    });
    try { api.CloseModel(m.modelID); } catch (e) { /* už zatvorený */ }
    st.models.splice(i, 1);
    Array.from(st.hidden).forEach(function (k) { if (k.indexOf(m.uid + ":") === 0) st.hidden.delete(k); });
    if (!st.models.length) { window.ModelTool.reset(); return; }
    detectGeoref();
    renderGeo();
    rebuildIndices();
    renderAll();
  }

  function renderAll() {
    search = { q: "", hits: [], at: -1 };
    $("mdHits").textContent = "";
    renderChips();
    renderLeft();
    renderSide();
    renderAlSelect();
    syncBar();
    syncToolbar();
  }

  function renderChips() {
    var nEl = 0, nAl = 0, schemas = {};
    st.models.forEach(function (m) { nEl += m.products.size; nAl += m.alignments.length; schemas[m.schema] = 1; });
    var maps = st.models.filter(function (m) { return m.map; });
    var mismatch = false;
    for (var i = 1; i < maps.length; i++) {
      var a = maps[0].map, b = maps[i].map;
      if (Math.abs(a.e - b.e) > 1e-3 || Math.abs(a.n - b.n) > 1e-3 || Math.abs(a.h - b.h) > 1e-3 ||
          Math.abs(Math.atan2(a.ay, a.ax) - Math.atan2(b.ay, b.ax)) > 1e-7) mismatch = true;
    }
    var html = '<span class="m">modely <b>' + st.models.length + "</b></span>" +
      '<span class="m">prvky s geometriou <b>' + nEl.toLocaleString("sk-SK") + "</b></span>" +
      '<span class="m">schéma <b>' + esc(Object.keys(schemas).join(", ")) + "</b></span>" +
      '<span class="m">trasy <b>' + nAl + "</b></span>";
    if (mismatch) html += '<span class="m is-warn">modely majú rozdielne georeferencovanie (IfcMapConversion) — nemusia na seba sedieť</span>';
    else if (st.models.length > 1 && maps.length && maps.length < st.models.length) html += '<span class="m is-warn">georeferencovanie má len časť modelov</span>';
    $("mdChips").innerHTML = html;
  }

  function renderLeft() {
    var html = '<div class="ml__sec">modely <button class="linkbtn" id="mdAdd2">+ pridať</button></div>';
    st.models.forEach(function (m) {
      var cls = Array.from(m.classes.entries()).sort(function (a, b) { return b[1].n - a[1].n || a[0].localeCompare(b[0]); });
      html += '<div class="mdm' + (m.visible ? "" : " is-off") + '" data-m="' + m.uid + '">' +
        '<div class="mdm__h">' +
          '<input type="checkbox" class="mdm__vis" title="zobraziť / skryť model"' + (m.visible ? " checked" : "") + ">" +
          '<span class="mdm__sw" style="background:' + m.color + '"></span>' +
          '<span class="mdm__n" title="' + esc(m.name) + '">' + esc(m.name) + "</span>" +
          '<button class="mdm__x" title="zavrieť model" data-rm="1">×</button>' +
        "</div>" +
        '<div class="mdm__meta">' + esc(m.schema) + " · " + m.products.size.toLocaleString("sk-SK") + " prvkov" +
          (m.map ? " · E " + fmt(m.map.e, 1) + " N " + fmt(m.map.n, 1) : "") + "</div>" +
        '<details class="mdm__cls"><summary>triedy (' + cls.length + ')</summary><div class="mdm__list">' +
          cls.map(function (c) {
            return '<label class="tf"><input type="checkbox" class="mdm__c" data-c="' + esc(c[0]) + '"' + (c[1].visible ? " checked" : "") + ">" +
              '<span class="tf__n">' + esc(prettyCls(c[0])) + '</span><span class="tf__c">' + c[1].n.toLocaleString("sk-SK") + "</span></label>";
          }).join("") +
        "</div></details>";
      if (m.alignments.length) {
        html += '<div class="mdm__als">' + m.alignments.map(function (a, i) {
          var on = st.sec.al && st.sec.al.a === a;
          return '<div class="al' + (on ? " is-on" : "") + '" data-al="' + i + '">' +
            '<input type="checkbox" class="al__vis" title="zobraziť os"' + (a.visible ? " checked" : "") + ">" +
            '<span class="al__n">' + esc(a.name || "trasa " + (i + 1)) + "</span>" +
            '<button class="al__go" title="priečne rezy po trase">' + (on ? "rezy ✓" : "rezy") + "</button>" +
            '<div class="al__m">km ' + AL.formatStation(a.startStation, 1) + " – " + AL.formatStation(a.endStation, 1) +
              " · " + fmt(a.length, 1) + " m" + (a.hasVertical ? "" : " · bez nivelety") + "</div>" +
          "</div>";
        }).join("") + "</div>";
      }
      html += "</div>";
    });
    $("mdLeft").innerHTML = html;
  }

  function renderAlSelect() {
    var opts = [];
    st.models.forEach(function (m) {
      m.alignments.forEach(function (a, i) {
        opts.push('<option value="' + a.key + '">' + esc((a.name || "trasa " + (i + 1)) + (st.models.length > 1 ? " — " + m.name : "")) + "</option>");
      });
    });
    $("secAl").innerHTML = opts.join("");
    if (st.sec.al) $("secAl").value = st.sec.al.a.key;
  }

  function findAlignment(k) {
    for (var i = 0; i < st.models.length; i++) {
      var m = st.models[i];
      for (var j = 0; j < m.alignments.length; j++) if (m.alignments[j].key === k) return { m: m, a: m.alignments[j] };
    }
    return null;
  }

  // ---- bočný panel s vlastnosťami ----------------------------------------
  var sideSeq = 0;
  function v(x) {
    if (x == null) return null;
    if (typeof x !== "object") return x;
    if (x.value !== undefined) return x.value;
    if (x._representationValue !== undefined) return x._representationValue;
    return null;
  }
  function valStr(x) {
    var r = v(x);
    if (r == null) return "—";
    if (typeof r === "number") return Math.abs(r) >= 1e6 || (Math.abs(r) < 1e-3 && r !== 0) ? r.toExponential(4) : String(+r.toFixed(6));
    if (r === "T" || r === true) return "áno";
    if (r === "F" || r === false) return "nie";
    return String(r);
  }

  function renderSide() {
    var el = $("mdSide"), seq = ++sideSeq;
    syncToolbar();      // bodka na tlačidle „vlastnosti“, keď je panel skrytý
    if (!st.sel) {
      el.innerHTML = '<div class="dt--empty"><p><b>Kliknite na prvok</b> v 3D pohľade alebo v reze — zobrazia sa jeho atribúty a vlastnosti.</p>' +
        "<p>Ovládanie: ľavé tlačidlo otáča, pravé posúva, koliesko približuje. Dvojklik nastaví stred otáčania.</p>" +
        "<p>Viac súborov sa zobrazí spolu v súradniciach projektu — vhodné na koordináciu profesií.</p></div>";
      return;
    }
    var m = st.sel.m, id = st.sel.id, line = null;
    try { line = api.GetLine(m.modelID, id, false); } catch (e) { line = null; }
    var cls = m.products.get(id) ? m.products.get(id).cls : (line ? typeName(line.type) : "");
    var attrs = [];
    if (line) ["GlobalId", "Name", "Description", "ObjectType", "Tag", "LongName", "PredefinedType"].forEach(function (k) {
      if (line[k] != null && v(line[k]) != null && v(line[k]) !== "") attrs.push([k, valStr(line[k])]);
    });
    var K = key(m, id);
    var doc = window.IFCDocs && IFCDocs.docFor ? IFCDocs.docFor(cls, m.schema) : null;
    var clsHtml = doc ? '<a class="doclink" href="' + esc(doc.url) + '" target="_blank" rel="noopener noreferrer" title="Dokumentácia ' + esc(doc.label) + '">' +
      esc(prettyCls(cls)) + '<span class="doclink__x">↗</span></a>' : esc(prettyCls(cls));
    var html = '<div class="dt__head"><span class="dt__id">#' + id + '</span><span class="dt__type">' + clsHtml + "</span></div>" +
      '<div class="dt__meta"><span class="mdm__sw" style="background:' + m.color + '"></span><span class="dt__where">' + esc(m.name) + "</span></div>" +
      '<div class="md-acts">' +
        '<button class="minibtn" data-act="focus">priblížiť</button>' +
        '<button class="minibtn" data-act="hide">skryť</button>' +
        '<button class="minibtn" data-act="iso">' + (st.isolate && st.isolate.size === 1 && st.isolate.has(K) ? "zrušiť izoláciu" : "izolovať") + "</button>" +
        (window.ViewerTool ? '<button class="minibtn" data-act="code">v kóde →</button>' : "") +
      "</div>" +
      '<div class="dt__sec">atribúty</div><div class="dt__attrs">' +
      (attrs.length ? attrs.map(function (a) {
        return '<div class="at"><span class="at__n">' + esc(a[0]) + '</span><span class="at__v">' + esc(a[1]) + "</span></div>";
      }).join("") : '<div class="dt__none">bez pomenovaných atribútov</div>') + "</div>" +
      '<div class="dt__sec">vlastnosti</div><div id="mdPsets"><div class="dt__none">načítava sa…</div></div>';
    el.innerHTML = html;

    Promise.all([
      api.properties.getPropertySets(m.modelID, id, true).catch(function () { return []; }),
      api.properties.getTypeProperties(m.modelID, id, true).catch(function () { return []; })
    ]).then(function (r) {
      if (seq !== sideSeq) return;
      var sets = (r[0] || []).map(function (s) { return { s: s, from: "" }; });
      (r[1] || []).forEach(function (t) {
        (t.HasPropertySets || []).forEach(function (s) { if (s && s.Name) sets.push({ s: s, from: "typ" }); });
      });
      var box = $("mdPsets"); if (!box) return;
      if (!sets.length) { box.innerHTML = '<div class="dt__none">prvok nemá property sety</div>'; return; }
      box.innerHTML = sets.map(function (x) {
        var s = x.s, props = s.HasProperties || s.Quantities || [];
        var rows = props.map(function (p) {
          if (!p) return "";
          var val = p.NominalValue != null ? valStr(p.NominalValue) :
            ["LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue"].reduce(function (acc, kk) {
              return acc != null ? acc : (p[kk] != null ? valStr(p[kk]) : null);
            }, null);
          if (val == null && p.EnumerationValues) val = (p.EnumerationValues || []).map(valStr).join(", ");
          return '<div class="pr"><span class="pr__n">' + esc(valStr(p.Name)) + '</span><span class="pr__v">' + esc(val == null ? "—" : val) + "</span></div>";
        }).join("");
        return '<div class="pset"><div class="pset__h">' + esc(valStr(s.Name)) +
          (x.from || s.Quantities ? '<span class="pset__t">' + (x.from ? "z typu" : "veličiny") + "</span>" : "") +
          "</div>" + (rows || '<div class="pr"><span class="pr__n dt__none">prázdny</span></div>') + "</div>";
      }).join("");
    });
  }

  function sideAction(act) {
    if (!st.sel) return;
    var m = st.sel.m, id = st.sel.id, K = key(m, id), p = m.products.get(id);
    if (act === "focus" && p) focusBox(boxOfProduct(m, p));
    else if (act === "hide") { st.hidden.add(K); select(null); rebuildIndices(); syncToolbar(); }
    else if (act === "iso") {
      st.isolate = st.isolate && st.isolate.has(K) && st.isolate.size === 1 ? null : new Set([K]);
      rebuildIndices(); renderSide(); syncToolbar();
      if (st.isolate && p) focusBox(boxOfProduct(m, p));
    } else if (act === "code" && window.ViewerTool) {
      window.ViewerTool.open({ file: m.file, id: id, back: { label: "← späť na 3D model", go: function () {
        if (window.AppBar && AppBar.go) AppBar.go("model"); else location.hash = "#/model";
      } } });
    }
  }

  /* Panel vlastností sa dá skryť — 3D pohľad sa roztiahne (ResizeObserver
     prepočíta plátno). Voľba sa pamätá medzi návštevami. */
  function setSide(open) {
    st.sideOpen = open;
    writePref("md.side", open ? "1" : "0");
    document.querySelector(".md__main").classList.toggle("no-side", !open);
    syncToolbar();
  }

  function syncToolbar() {
    $("mdShowAll").disabled = !st.hidden.size && !st.isolate;
    $("mdShowAll").textContent = "zobraziť všetko" + (st.hidden.size ? " (" + st.hidden.size + " skrytých)" : st.isolate ? " (izolácia)" : "");
    $("mdColor").classList.toggle("is-on", st.colorMode === "model");
    $("mdSideBtn").classList.toggle("is-on", st.sideOpen);
    $("mdSideBtn").classList.toggle("has-sel", !st.sideOpen && !!st.sel);
    $("mdGhost").classList.toggle("is-on", st.ghost);
  }

  function syncBar() {
    if (!window.AppBar) return;
    var n = st.models.length;
    AppBar.setStatus(n ? (n === 1 ? st.models[0].name : n + " " + plural(n, "model", "modely", "modelov") + " · " +
      st.models.map(function (m) { return m.name; }).join(", ")) : "3D prehliadač a koordinácia");
    AppBar.setBadge("");
    if (three) requestAnimationFrame(function () { resize(); sizeSecCanvas(); });
  }

  // ---- vyhľadávanie prvkov ---------------------------------------------------
  /* Názvy a GlobalId sa čítajú až pri prvom hľadaní — pri veľkých modeloch to
     trvá, a kto nehľadá, nemusí čakať. */
  var search = { q: "", hits: [], at: -1 };
  function ensureNames(m) {
    if (m.names) return;
    m.names = new Map();
    m.products.forEach(function (p) {
      var l = null;
      try { l = api.GetLine(m.modelID, p.id, false); } catch (e) { l = null; }
      m.names.set(p.id, {
        name: l && l.Name ? String(v(l.Name) || "") : "",
        guid: l && l.GlobalId ? String(v(l.GlobalId) || "") : "",
        tag: l && l.Tag ? String(v(l.Tag) || "") : ""
      });
    });
  }
  function runSearch(q) {
    q = q.trim();
    search = { q: q, hits: [], at: -1 };
    if (!q) { $("mdHits").textContent = ""; $("mdQ").parentElement.classList.remove("is-empty"); return; }
    var idq = /^#?(\d+)$/.exec(q), lq = q.toLowerCase();
    st.models.forEach(function (m) {
      if (!m.visible) return;
      if (!idq) ensureNames(m);
      m.products.forEach(function (p) {
        var ok;
        if (idq) ok = p.id === +idq[1];
        else {
          var n = m.names.get(p.id);
          ok = n.guid === q || n.name.toLowerCase().indexOf(lq) >= 0 || n.tag.toLowerCase() === lq ||
               prettyCls(p.cls).toLowerCase().indexOf(lq) >= 0;
        }
        if (ok) search.hits.push({ m: m, id: p.id });
      });
    });
    $("mdQ").parentElement.classList.toggle("is-empty", !search.hits.length);
    if (!search.hits.length) { $("mdHits").textContent = "nič"; return; }
    stepSearch(1);
  }
  function stepSearch(dir) {
    var n = search.hits.length; if (!n) return;
    search.at = (search.at + dir + n) % n;
    var h = search.hits[search.at];
    var p = h.m.products.get(h.id);
    // nájdený prvok musí byť vidieť — zruší sa jeho skrytie aj skrytie triedy
    var k = key(h.m, h.id), changed = false;
    if (st.hidden.delete(k)) changed = true;
    if (st.isolate && !st.isolate.has(k)) { st.isolate = null; changed = true; }
    var c = h.m.classes.get(p.cls);
    if (c && !c.visible) { c.visible = true; changed = true; renderLeft(); }
    if (changed) { rebuildIndices(); syncToolbar(); }
    select(h.m, h.id, { focus: true });
    $("mdHits").textContent = (search.at + 1) + " / " + n;
  }

  // ---- udalosti -------------------------------------------------------------
  function wire() {
    $("fileM").addEventListener("change", function (e) {
      if (e.target.files && e.target.files.length) addFiles(e.target.files);
      e.target.value = "";
    });
    wireDrop($("mdView"));
    $("mdAdd").addEventListener("click", function () { $("fileM").click(); });
    $("mdQ").addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (this.value.trim() === search.q && search.hits.length) stepSearch(e.shiftKey ? -1 : 1);
      else runSearch(this.value);
    });
    $("mdQ").addEventListener("input", function () { if (!this.value) runSearch(""); });
    $("mdFit").addEventListener("click", function () { focusBox(visibleBox()); });
    $("mdTop").addEventListener("click", function () { focusBox(visibleBox(), new Lib.T.Vector3(0, 1, 0.0005)); });
    $("mdIso").addEventListener("click", function () { focusBox(visibleBox(), new Lib.T.Vector3(1, 0.8, 1)); });
    $("mdColor").addEventListener("click", function () {
      st.colorMode = st.colorMode === "model" ? "file" : "model";
      applyMaterials(); syncToolbar(); drawSection();
    });
    $("mdGhost").addEventListener("click", function () { st.ghost = !st.ghost; applyMaterials(); syncToolbar(); });
    $("mdSideBtn").addEventListener("click", function () { setSide(!st.sideOpen); });
    $("mdSideX").addEventListener("click", function () { setSide(false); });
    $("mdShowAll").addEventListener("click", function () {
      st.hidden.clear(); st.isolate = null; rebuildIndices(); renderSide(); syncToolbar();
    });

    $("mdLeft").addEventListener("click", function (e) {
      if (e.target.id === "mdAdd2") { $("fileM").click(); return; }
      var mm = e.target.closest(".mdm"); if (!mm) return;
      var m = st.models.filter(function (x) { return x.uid === +mm.getAttribute("data-m"); })[0];
      if (!m) return;
      if (e.target.closest("[data-rm]")) { removeModel(m); return; }
      var al = e.target.closest(".al");
      if (al && e.target.closest(".al__go")) {
        var a = m.alignments[+al.getAttribute("data-al")];
        if (st.sec.al && st.sec.al.a === a) closeSection(); else openSection(m, a);
      }
    });
    $("mdLeft").addEventListener("change", function (e) {
      var mm = e.target.closest(".mdm"); if (!mm) return;
      var m = st.models.filter(function (x) { return x.uid === +mm.getAttribute("data-m"); })[0];
      if (!m) return;
      if (e.target.classList.contains("mdm__vis")) {
        m.visible = e.target.checked; m.group.visible = m.visible;
        mm.classList.toggle("is-off", !m.visible);
        if (!m.visible && st.sel && st.sel.m === m) select(null);
        rebuildIndices();
      } else if (e.target.classList.contains("mdm__c")) {
        var c = m.classes.get(e.target.getAttribute("data-c"));
        if (c) { c.visible = e.target.checked; rebuildIndices(); }
      } else if (e.target.classList.contains("al__vis")) {
        var a = m.alignments[+e.target.closest(".al").getAttribute("data-al")];
        a.visible = e.target.checked; if (a.obj) a.obj.visible = a.visible && m.visible;
        requestRender();
      }
    });
    $("mdSide").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]"); if (b) sideAction(b.getAttribute("data-act"));
    });
    document.addEventListener("keydown", function (e) {
      if (!$("view-model").classList.contains("is-active") || !st.models.length) return;
      if (/INPUT|SELECT|TEXTAREA/.test((e.target.tagName || ""))) return;
      if (e.key === "Escape") select(null);
      else if ((e.key === "h" || e.key === "H") && st.sel) sideAction("hide");
      else if ((e.key === "i" || e.key === "I") && st.sel) sideAction("iso");
      else if (e.key === "p" || e.key === "P") setSide(!st.sideOpen);
      else if ((e.key === "f" || e.key === "F")) { if (st.sel) sideAction("focus"); else focusBox(visibleBox()); }
      else if (st.sec.al && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault(); setStation(st.sec.station + (e.key === "PageDown" ? 1 : -1) * st.sec.step, { keepView: true });
      }
    });

    // ---- rezy
    $("secAl").addEventListener("change", function () {
      var f = findAlignment(this.value); if (f) openSection(f.m, f.a);
    });
    $("secSt").addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var s = AL.parseStation(this.value);
      this.classList.toggle("is-bad", s == null);
      if (s != null) setStation(s);
    });
    $("secSt").addEventListener("blur", function () {
      var s = AL.parseStation(this.value);
      if (s != null && Math.abs(s - st.sec.station) > 1e-6) setStation(s);
      else this.value = AL.formatStation(st.sec.station);
      this.classList.remove("is-bad");
    });
    $("secRange").addEventListener("input", function () { setStation(+this.value, { keepView: true }); });
    $("secPrev").addEventListener("click", function () { setStation(st.sec.station - st.sec.step, { keepView: true }); });
    $("secNext").addEventListener("click", function () { setStation(st.sec.station + st.sec.step, { keepView: true }); });
    $("secSnapP").addEventListener("click", function () { snap(-1); });
    $("secSnapN").addEventListener("click", function () { snap(1); });
    $("secStep").addEventListener("change", function () { st.sec.step = +this.value || 10; });
    $("secWidth").addEventListener("change", function () { st.sec.width = +this.value || 0; st.sec.view = null; refreshSection(); });
    $("secClip").addEventListener("change", function () { st.sec.clip = this.value; setClip(); requestRender(); });
    $("secLook").addEventListener("click", lookAtSection);
    $("secClose").addEventListener("click", closeSection);
    $("secSvg").addEventListener("click", function () { if (st.sec.mode === "long") exportProfile(); else exportCurrent(); });
    $("secModeX").addEventListener("click", function () { setMode("cross"); });
    $("secModeL").addEventListener("click", function () { setMode("long"); });
    $("secExag").addEventListener("change", function () {
      st.sec.exag = +this.value || 10;
      // pri zmene prevýšenia zostane stred aj vodorovná mierka
      drawSection();
    });
    $("secSer").addEventListener("click", exportSeries);
    $("secFit").addEventListener("click", function () {
      if (st.sec.mode === "long") st.sec.pview = null; else st.sec.view = null;
      drawSection();
    });
    wireSecCanvas();
    wireGeo();
    new ResizeObserver(function () { if (!$("mdSec").hidden) sizeSecCanvas(); }).observe($("secWrap"));
  }

  /* Skok na najbližšie zaokrúhlené staničenie podľa kroku (napr. na celé 20 m). */
  function snap(dir) {
    var s = st.sec.station, step = st.sec.step;
    var n = dir > 0 ? Math.floor(s / step + 1e-9) + 1 : Math.ceil(s / step - 1e-9) - 1;
    setStation(n * step, { keepView: true });
  }

  /* Kamera v osi trasy pred rezom, pohľad v smere staničenia. */
  function lookAtSection() {
    var d = st.sec.data; if (!d) return;
    var F = d.frame, cam = three.camera;
    var w = isFinite(d.bb[0]) ? Math.max(d.bb[2] - d.bb[0], 10) : 30;
    var dist = w / 2 / Math.tan(cam.fov * Math.PI / 360) * 1.15;
    var target = F.P.clone();
    if (isFinite(d.bb[1])) target.y += (d.bb[1] + d.bb[3]) / 2 - F.p.z;
    cam.position.copy(target).addScaledVector(F.T, -dist).add(new Lib.T.Vector3(0, dist * 0.08, 0));
    cam.near = Math.max(0.01, dist / 2000); cam.far = Math.max(cam.far, dist * 50);
    cam.updateProjectionMatrix();
    three.controls.target.copy(target);
    three.controls.update();
    requestRender();
  }

  window.ModelTool = {
    syncBar: syncBar,
    reset: function () {
      if (st.busy) return;
      if (three) {
        st.models.slice().forEach(function (m) {
          three.scene.remove(m.group);
          m.group.traverse(function (o) {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
            if (o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
          });
          try { api.CloseModel(m.modelID); } catch (e) { /* nič */ }
        });
        clearHilite();
      }
      st.models = []; st.origin = null; st.sel = null; st.hidden = new Set(); st.isolate = null;
      st.sec.al = null; st.sec.data = null; st.sec.view = null; st.sec.prof = null; st.sec.pview = null;
      if (three) { removeTerrain(); three.clip = []; drawSection3D(); }
      st.geo.georef = null; st.geo.manual = false; st.geo.note = ""; st.geo.status = ""; st.geo.attr = "";
      $("mdGeo").open = false;
      $("mdApp").hidden = true; $("mdSec").hidden = true;
      renderDrop();
      syncBar();
    }
  };

  if ($("mdPanel")) {
    wire(); renderDrop();
    if (!st.sideOpen) document.querySelector(".md__main").classList.add("no-side");
  }
})();
