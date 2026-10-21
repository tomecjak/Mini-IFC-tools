/* model.js — 3D prehliadač IFC modelov a koordinácia viacerých súborov (nástroj [04]).
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
    return {
      e: v(e.Eastings), n: v(e.Northings), h: v(e.OrthogonalHeight),
      ax: e.XAxisAbscissa ? v(e.XAxisAbscissa) : 1, ay: e.XAxisOrdinate ? v(e.XAxisOrdinate) : 0,
      crs: crs && crs.Name ? String(crs.Name.value || "") : ""
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
  function computeSection(stn) {
    var F = sectionFrame(stn), items = [];
    var halfW = st.sec.width > 0 ? st.sec.width : Infinity;
    st.models.forEach(function (m) {
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
      if (ctx.isPointInPath(sec2d.paths[i].path, x * (sec2d.cv.width / sec2d.w), y * (sec2d.cv.height / sec2d.h), "evenodd")) return sec2d.paths[i].it;
    }
    // najbližšia čiara do 6 px
    var V = st.sec.view, best = null, bd = 6;
    if (!V || !st.sec.data) return null;
    st.sec.data.items.forEach(function (it) {
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
    $("secSvg").textContent = long ? "profil do SVG ↓" : "rez do SVG ↓";
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

    st.models.forEach(function (m) {
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
        ch.open = ch.open.filter(function (Lp) {
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

  // ---- export profilu do SVG ------------------------------------------------
  var H_SCALES = [200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];
  function exportProfile() {
    var pr = st.sec.prof; if (!pr) return;
    var a = pr.a, ex = st.sec.exag;
    var len = a.endStation - a.startStation;
    // vodorovná mierka tak, aby sa profil zmestil do ~1 200 mm
    var hs = H_SCALES.filter(function (s) { return len * 1000 / s <= 1200; })[0] || 100000;
    var k = 1000 / hs, kv = k * ex;              // mm na 1 m vodorovne / zvisle
    var y0 = isFinite(pr.bb[1]) ? pr.bb[1] : 0, y1 = isFinite(pr.bb[3]) ? pr.bb[3] : 10;
    var gs = niceStep(8 / kv);
    y0 = Math.floor(y0 / gs) * gs - gs; y1 = Math.ceil(y1 / gs) * gs + gs;
    var L = 22, PW = len * k, PH = (y1 - y0) * kv, top = 24, band = 14;
    var Wd = L + PW + 12, Hd = top + PH + band + 18;
    var X = function (x) { return L + (x - a.startStation) * k; };
    var Y = function (y) { return top + (y1 - y) * kv; };
    var o = [];
    o.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + Wd.toFixed(1) + 'mm" height="' + Hd.toFixed(1) + 'mm" viewBox="0 0 ' + Wd.toFixed(1) + " " + Hd.toFixed(1) + '" font-family="IBM Plex Mono, monospace">');
    o.push('<rect width="100%" height="100%" fill="#fff"/>');
    o.push('<text x="' + L + '" y="10" font-size="4.2" font-weight="600">Pozdĺžny profil — ' + esc(a.name || "trasa") + "</text>");
    o.push('<text x="' + L + '" y="16" font-size="2.8" fill="#5C5A52">M 1:' + hs + " / 1:" + Math.round(hs / ex) + " (prevýšenie " + ex + "×) · km " +
      AL.formatStation(a.startStation, 3) + " – " + AL.formatStation(a.endStation, 3) + " · výšky v m · mini-ifc/tools</text>");
    o.push('<rect x="' + L + '" y="' + top + '" width="' + PW.toFixed(2) + '" height="' + PH.toFixed(2) + '" fill="none" stroke="#D3CFC4" stroke-width="0.25"/>');
    var xs = niceStep(14 / k);
    for (var x = Math.ceil(a.startStation / xs) * xs; x <= a.endStation + 1e-9; x += xs) {
      o.push('<line x1="' + X(x).toFixed(2) + '" y1="' + top + '" x2="' + X(x).toFixed(2) + '" y2="' + (top + PH).toFixed(2) + '" stroke="#ECEAE3" stroke-width="0.15"/>');
      o.push('<text x="' + X(x).toFixed(2) + '" y="' + (top + PH + band + 4).toFixed(2) + '" font-size="2" fill="#5C5A52" text-anchor="middle">' + stLabel(Math.round(x / xs) * xs, xs) + "</text>");
    }
    for (var y = y0; y <= y1 + 1e-9; y += gs) {
      o.push('<line x1="' + L + '" y1="' + Y(y).toFixed(2) + '" x2="' + (L + PW).toFixed(2) + '" y2="' + Y(y).toFixed(2) + '" stroke="#ECEAE3" stroke-width="0.15"/>');
      o.push('<text x="' + (L - 1.5) + '" y="' + (Y(y) + 0.7).toFixed(2) + '" font-size="2" fill="#98958A" text-anchor="end">' + fmt(Math.round(y / gs) * gs || 0, gs < 1 ? 1 : 0) + "</text>");
    }
    o.push('<clipPath id="pc"><rect x="' + L + '" y="' + top + '" width="' + PW.toFixed(2) + '" height="' + PH.toFixed(2) + '"/></clipPath><g clip-path="url(#pc)">');
    pr.items.forEach(function (it) {
      var dd = "", od = "";
      it.loops.forEach(function (Lp) {
        for (var j = 0; j < Lp.length; j += 2) dd += (j ? "L" : "M") + X(Lp[j]).toFixed(2) + " " + Y(Lp[j + 1]).toFixed(2);
        dd += "Z";
      });
      it.open.forEach(function (Lp) {
        for (var j = 0; j < Lp.length; j += 2) od += (j ? "L" : "M") + X(Lp[j]).toFixed(2) + " " + Y(Lp[j + 1]).toFixed(2);
      });
      if (dd) o.push('<path d="' + dd + '" fill="' + itemColor(it, 0.38) + '" fill-rule="evenodd" stroke="' + strokeColor(it) + '" stroke-width="0.15"><title>' + esc(prettyCls(it.cls) + " #" + it.id) + "</title></path>");
      if (od) o.push('<path d="' + od + '" fill="none" stroke="' + strokeColor(it) + '" stroke-width="0.15"/>');
    });
    if (pr.nivel.length) {
      o.push('<path d="' + pr.nivel.map(function (n, i) { return (i ? "L" : "M") + X(n[0]).toFixed(2) + " " + Y(n[1]).toFixed(2); }).join("") +
        '" fill="none" stroke="#D0216A" stroke-width="0.35"/>');
      a.vertical.forEach(function (sg, i) {
        var z = a.pointAt(sg.start).z, xx = X(a.startStation + sg.start);
        o.push('<circle cx="' + xx.toFixed(2) + '" cy="' + Y(z).toFixed(2) + '" r="0.5" fill="#D0216A"/>');
        o.push('<text transform="translate(' + (xx - 0.6).toFixed(2) + " " + (Y(z) - 2).toFixed(2) + ') rotate(-90)" font-size="1.8" fill="#A01B55">' +
          "km " + AL.formatStation(a.startStation + sg.start, 2) + " · " + fmt(z, 3) + "</text>");
        if (sg.length * k > 14) {
          var mid = sg.start + sg.length / 2;
          o.push('<text x="' + X(a.startStation + mid).toFixed(2) + '" y="' + (Y(a.pointAt(mid).z) - 1.5).toFixed(2) + '" font-size="2.2" text-anchor="middle" fill="' +
            (sg.type === "CONSTANTGRADIENT" ? "#A01B55" : "#4B3F8F") + '">' +
            (sg.type === "CONSTANTGRADIENT" ? fmt(sg.g0 * 100, 2) + " %" : "R " + fmt(Math.abs(sg.r || 0), 0)) + "</text>");
        }
        if (i === a.vertical.length - 1) {
          var ze = a.pointAt(sg.start + sg.length).z;
          o.push('<circle cx="' + X(a.startStation + sg.start + sg.length).toFixed(2) + '" cy="' + Y(ze).toFixed(2) + '" r="0.5" fill="#D0216A"/>');
        }
      });
    }
    o.push("</g>");
    // pás smerových pomerov
    var by = top + PH, kmax = 0;
    pr.curv.forEach(function (c) { kmax = Math.max(kmax, Math.abs(c[1])); });
    o.push('<rect x="' + L + '" y="' + by.toFixed(2) + '" width="' + PW.toFixed(2) + '" height="' + band + '" fill="none" stroke="#D3CFC4" stroke-width="0.25"/>');
    o.push('<line x1="' + L + '" y1="' + (by + band / 2).toFixed(2) + '" x2="' + (L + PW).toFixed(2) + '" y2="' + (by + band / 2).toFixed(2) + '" stroke="#ECEAE3" stroke-width="0.15"/>');
    if (kmax > 0) o.push('<path d="' + pr.curv.map(function (c, i) {
      return (i ? "L" : "M") + X(c[0]).toFixed(2) + " " + (by + band / 2 - c[1] / kmax * (band / 2 - 2)).toFixed(2);
    }).join("") + '" fill="none" stroke="#4B3F8F" stroke-width="0.25"/>');
    o.push('<text x="' + (L - 1.5) + '" y="' + (by + band / 2 + 0.7).toFixed(2) + '" font-size="1.8" fill="#98958A" text-anchor="end">smer</text>');
    a.horizontal.forEach(function (h) {
      if (h.length * k < 12 || h.type === "LINE") return;
      var R = h.type === "CIRCULARARC" ? "R " + fmt(Math.abs(h.r0), 0) : h.type.toLowerCase().replace("curve", "");
      o.push('<text x="' + X(a.startStation + h.start + h.length / 2).toFixed(2) + '" y="' + (by + band - 1.2).toFixed(2) + '" font-size="1.8" fill="#4B3F8F" text-anchor="middle">' + esc(R) + "</text>");
    });
    o.push("</svg>");
    download("profil_" + safeName(a.name) + ".svg", o.join("\n"), "image/svg+xml");
  }

  // ---- export rezov do SVG -------------------------------------------------
  var SCALES = [20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  function svgSections(list) {
    // spoločná mierka: najmenšia z normových, pri ktorej sa každý rez zmestí do rámu
    var FW = 180, FH = 110;   // kresliaca plocha rezu v mm
    var maxW = 1, maxH = 1;
    list.forEach(function (d) {
      var V = fitBounds(d);
      maxW = Math.max(maxW, V.w); maxH = Math.max(maxH, V.h);
    });
    var need = Math.max(maxW * 1000 / FW, maxH * 1000 / FH);
    var scale = SCALES.filter(function (s) { return s >= need; })[0] || Math.ceil(need / 1000) * 1000;
    var k = 1000 / scale;     // mm na papieri na 1 m
    var cols = list.length > 1 ? 2 : 1, CW = FW + 20, CH = FH + 34;
    var rows = Math.ceil(list.length / cols);
    var W = cols * CW + 10, Hh = rows * CH + 26;
    var a = st.sec.al.a, out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + Hh + 'mm" viewBox="0 0 ' + W + " " + Hh + '" font-family="IBM Plex Mono, monospace">');
    out.push('<rect width="100%" height="100%" fill="#fff"/>');
    out.push('<text x="10" y="12" font-size="4.2" font-weight="600">Priečne rezy — ' + esc(a.name || "trasa") + "</text>");
    out.push('<text x="10" y="18" font-size="2.8" fill="#5C5A52">M 1:' + scale + " · " + list.length + " " + plural(list.length, "rez", "rezy", "rezov") +
             " · odsun od osi vpravo kladný, výšky v m · mini-ifc/tools</text>");
    list.forEach(function (d, i) {
      var ox = 10 + (i % cols) * CW, oy = 24 + Math.floor(i / cols) * CH;
      var V = fitBounds(d), z = d.frame.p.z;
      var cu = V.cu, cvv = V.cv;
      var X = function (u) { return ox + FW / 2 + (u - cu) * k; };
      var Y = function (v) { return oy + 8 + FH / 2 - (v - cvv) * k; };
      out.push('<g><rect x="' + ox + '" y="' + oy + '" width="' + FW + '" height="' + (FH + 16) + '" fill="none" stroke="#D3CFC4" stroke-width="0.25"/>');
      out.push('<text x="' + (ox + 3) + '" y="' + (oy + 5) + '" font-size="3.4" font-weight="600">km ' + AL.formatStation(d.station) + "</text>");
      if (d.frame.p.hasZ) out.push('<text x="' + (ox + FW - 3) + '" y="' + (oy + 5) + '" font-size="2.6" text-anchor="end" fill="#5C5A52">niveleta ' + fmt(z, 3) + " · sklon " + fmt(d.frame.p.gradient * 100, 2) + " %</text>");
      out.push('<clipPath id="c' + i + '"><rect x="' + ox + '" y="' + (oy + 8) + '" width="' + FW + '" height="' + FH + '"/></clipPath><g clip-path="url(#c' + i + ')">');
      // mriežka po 1 / 2 / 5 … m podľa mierky
      var gs = niceStep(15 / k);
      var u0 = cu - FW / 2 / k, u1 = cu + FW / 2 / k, v0 = cvv - FH / 2 / k, v1 = cvv + FH / 2 / k;
      for (var u = Math.ceil(u0 / gs) * gs; u <= u1; u += gs) {
        var axis = Math.abs(u) < 1e-9, ur = Math.round(u / gs) * gs || 0;
        out.push('<line x1="' + X(u).toFixed(2) + '" y1="' + (oy + 8) + '" x2="' + X(u).toFixed(2) + '" y2="' + (oy + 8 + FH) + '" stroke="' + (axis ? "#D0216A" : "#ECEAE3") + '" stroke-width="' + (axis ? 0.3 : 0.15) + '"' + (axis ? ' stroke-dasharray="2 1.2"' : "") + "/>");
        out.push('<text x="' + X(u).toFixed(2) + '" y="' + (oy + FH + 11) + '" font-size="2" fill="#98958A" text-anchor="middle">' + (ur > 0 ? "+" : "") + fmt(ur, gs < 1 ? 1 : 0) + "</text>");
      }
      for (var v = Math.ceil(v0 / gs) * gs; v <= v1; v += gs) {
        out.push('<line x1="' + ox + '" y1="' + Y(v).toFixed(2) + '" x2="' + (ox + FW) + '" y2="' + Y(v).toFixed(2) + '" stroke="#ECEAE3" stroke-width="0.15"/>');
        out.push('<text x="' + (ox + 1.5) + '" y="' + (Y(v) - 0.6).toFixed(2) + '" font-size="2" fill="#98958A">' + fmt(Math.round(v / gs) * gs || 0, gs < 1 ? 1 : 0) + "</text>");
      }
      d.items.forEach(function (it) {
        var dd = "";
        it.loops.forEach(function (L) {
          for (var j = 0; j < L.length; j += 2) dd += (j ? "L" : "M") + X(L[j]).toFixed(2) + " " + Y(L[j + 1]).toFixed(2);
          dd += "Z";
        });
        var od = "";
        it.open.forEach(function (L) {
          for (var j = 0; j < L.length; j += 2) od += (j ? "L" : "M") + X(L[j]).toFixed(2) + " " + Y(L[j + 1]).toFixed(2);
        });
        var cls = prettyCls(it.cls);
        if (dd) out.push('<path d="' + dd + '" fill="' + itemColor(it, 0.38) + '" fill-rule="evenodd" stroke="' + strokeColor(it) + '" stroke-width="0.2"><title>' + esc(cls + " #" + it.id) + "</title></path>");
        if (od) out.push('<path d="' + od + '" fill="none" stroke="' + strokeColor(it) + '" stroke-width="0.2"/>');
      });
      if (d.frame.p.hasZ) {
        var ax = X(0), ay = Y(z);
        out.push('<path d="M' + ax.toFixed(2) + " " + ay.toFixed(2) + "l-1.2 -2h2.4z" + '" fill="#D0216A"/>');
      }
      out.push("</g>");
      out.push('<text x="' + (ox + 3) + '" y="' + (oy + FH + 14.6) + '" font-size="2.2" fill="#98958A">◄ vľavo</text><text x="' + (ox + FW - 3) + '" y="' + (oy + FH + 14.6) + '" font-size="2.2" fill="#98958A" text-anchor="end">vpravo ►</text>');
      out.push("</g>");
    });
    out.push("</svg>");
    return out.join("\n");
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
    download("rez_" + safeName(a.name) + "_km" + AL.formatStation(st.sec.station).replace(/[,.]/g, "_") + ".svg",
             svgSections([st.sec.data]), "image/svg+xml");
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
      download("rezy_" + safeName(a.name) + ".svg", svgSections(data), "image/svg+xml");
      msg.textContent = "Hotovo — " + list.length + " " + plural(list.length, "rez", "rezy", "rezov") + " v jednom SVG.";
    }, 30);
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

  function syncToolbar() {
    $("mdShowAll").disabled = !st.hidden.size && !st.isolate;
    $("mdShowAll").textContent = "zobraziť všetko" + (st.hidden.size ? " (" + st.hidden.size + " skrytých)" : st.isolate ? " (izolácia)" : "");
    $("mdColor").classList.toggle("is-on", st.colorMode === "model");
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
      if (three) { three.clip = []; drawSection3D(); }
      $("mdApp").hidden = true; $("mdSec").hidden = true;
      renderDrop();
      syncBar();
    }
  };

  if ($("mdPanel")) { wire(); renderDrop(); }
})();
