/* landxml.js — čítanie LandXML 1.x (trasy a povrchy TIN) pre 3D prehliadač.
 *
 * Funguje v prehliadači (DOMParser) aj v Node, ak sa mu podá parser XML.
 * Výsledok nemá súradnice scény — sú v mapovom systéme súboru (E, N, výška
 * v metroch); do súradníc projektu ich prevedie js/model.js.
 *
 *   trasy   — smerové riešenie z <CoordGeom> (Line, Curve, Spiral, IrregularLine)
 *             v tvare úsekov ako IfcAlignmentHorizontalSegment, aby ich spracovalo
 *             to isté jadro ako IFC 4.3 (js/ifc-alignment.js); niveleta z prvého
 *             <ProfAlign> (PVI, ParaCurve, UnsymParaCurve, CircCurve).
 *             Návrhová rýchlosť z <Feature name="SpeedStation"> (zápis Civil 3D).
 *   povrchy — <Surface><Definition surfType="TIN"> s bodmi <P> a trojuholníkmi <F>.
 *
 * Poradie súradníc v LandXML je „sever východ výška“ (N E Z).
 */
(function (root) {
  "use strict";

  // dĺžkové jednotky LandXML → metre
  var LEN = {
    meter: 1, kilometer: 1000, millimeter: 1e-3, centimeter: 1e-2,
    foot: 0.3048, USSurveyFoot: 1200 / 3937, inch: 0.0254, mile: 1609.344
  };
  // typy prechodníc LandXML → tvary krivosti v js/ifc-alignment.js
  var SPIRAL = {
    clothoid: "CLOTHOID", bloss: "BLOSSCURVE", cosine: "COSINECURVE", sinusoid: "SINECURVE",
    biquadratic: "HELMERTCURVE", weinerBogen: "VIENNESEBEND",
    cubic: "CUBIC", cubicParabola: "CUBIC", japaneseCubic: "CUBIC"
  };
  var TWO_PI = Math.PI * 2;

  function kids(el, name) {
    var out = [];
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && (!name || c.localName === name)) out.push(c);
    }
    return out;
  }
  function kid(el, name) { return el ? kids(el, name)[0] || null : null; }
  function all(el, name) { return Array.prototype.slice.call(el.getElementsByTagNameNS("*", name)); }
  function nums(text) {
    return String(text || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  }
  function attrNum(el, name) {
    var v = el.getAttribute(name);
    if (v == null || v === "") return null;
    if (/^inf/i.test(v)) return Infinity;
    v = +v;
    return isFinite(v) ? v : null;
  }

  /* Bod „N E [Z]“ → [E, N, Z] v metroch. Bod môže byť aj odkazom na CgPoint (pntRef). */
  function point(el, f, cg) {
    if (!el) return null;
    var t = el.textContent, ref = el.getAttribute("pntRef");
    if ((!t || !t.trim()) && ref && cg) t = cg[ref];
    var n = nums(t);
    if (n.length < 2 || !isFinite(n[0]) || !isFinite(n[1])) return null;
    return [n[1] * f, n[0] * f, n.length > 2 && isFinite(n[2]) ? n[2] * f : null];
  }

  function angle(a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]); }
  function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
  function wrap(a) { a %= TWO_PI; return a < 0 ? a + TWO_PI : a; }
  // polomer z LandXML → polomer úseku (+ doľava, − doprava, 0 = priamka)
  function radius(r, cw) {
    if (r == null || !isFinite(r) || Math.abs(r) > 1e8 || r === 0) return 0;
    return cw ? -Math.abs(r) : Math.abs(r);
  }

  // ---- smerové riešenie ----------------------------------------------------
  function horizontal(cg, f, cgPts, warn) {
    var hs = [], lastDir = null;
    function push(seg) { if (seg.len > 1e-9) { hs.push(seg); lastDir = seg.endDir; } }

    kids(cg).forEach(function (el) {
      var t = el.localName;
      if (t === "Line") {
        var a = point(kid(el, "Start"), f, cgPts), b = point(kid(el, "End"), f, cgPts);
        if (!a || !b) return;
        var d = angle(a, b);
        push({ type: "LINE", x: a[0], y: a[1], dir: d, r0: 0, r1: 0, len: dist(a, b), endDir: d });
      } else if (t === "Curve") {
        var s = point(kid(el, "Start"), f, cgPts), c = point(kid(el, "Center"), f, cgPts),
            e = point(kid(el, "End"), f, cgPts), pi = point(kid(el, "PI"), f, cgPts);
        if (!s) return;
        var cw = (el.getAttribute("rot") || "").toLowerCase() === "cw";
        var R = c ? dist(c, s) : (attrNum(el, "radius") || 0) * f, len = (attrNum(el, "length") || 0) * f, dir;
        if (c) {
          dir = angle(c, s) + (cw ? -Math.PI / 2 : Math.PI / 2);
          if (e) {
            var a0 = angle(c, s), a1 = angle(c, e);
            var sweep = cw ? wrap(a0 - a1) : wrap(a1 - a0);
            if (sweep > 1e-12) len = R * sweep;
          }
        } else if (pi) dir = angle(s, pi);
        else if (lastDir != null) dir = lastDir;
        else { warn("oblúk bez stredu a bez PI — trasa sa nedá zostaviť"); return; }
        if (!(R > 0) || !(len > 0)) return;
        push({ type: "CIRCULARARC", x: s[0], y: s[1], dir: dir, r0: radius(R, cw), r1: radius(R, cw), len: len,
               endDir: dir + (cw ? -1 : 1) * len / R });
      } else if (t === "Spiral") {
        var s2 = point(kid(el, "Start"), f, cgPts), pi2 = point(kid(el, "PI"), f, cgPts), e2 = point(kid(el, "End"), f, cgPts);
        if (!s2) return;
        var cw2 = (el.getAttribute("rot") || "").toLowerCase() === "cw";
        var L = (attrNum(el, "length") || 0) * f;
        var rs = attrNum(el, "radiusStart"), re = attrNum(el, "radiusEnd");
        rs = rs == null || !isFinite(rs) ? rs : rs * f; re = re == null || !isFinite(re) ? re : re * f;
        var kind = el.getAttribute("spiType") || "clothoid";
        var type = SPIRAL[kind];
        if (!type) { type = "CLOTHOID"; warn("prechodnica „" + kind + "“ je nahradená klotoidou"); }
        // dotyčnica na začiatku prechodnice prechádza bodom PI
        var d2 = pi2 ? angle(s2, pi2) : lastDir != null ? lastDir : e2 ? angle(s2, e2) : 0;
        if (!(L > 0)) return;
        var k0 = rs && isFinite(rs) ? 1 / rs : 0, k1 = re && isFinite(re) ? 1 / re : 0;
        var sg = cw2 ? -1 : 1;
        push({ type: type, x: s2[0], y: s2[1], dir: d2, r0: radius(rs, cw2), r1: radius(re, cw2), len: L,
               endDir: d2 + sg * (k0 + k1) / 2 * L });
      } else if (t === "IrregularLine") {
        var pl = nums((kid(el, "PntList2D") || kid(el, "PntList3D") || {}).textContent);
        var step = kid(el, "PntList3D") && !kid(el, "PntList2D") ? 3 : 2, prev = null;
        for (var i = 0; i + 1 < pl.length; i += step) {
          var p = [pl[i + 1] * f, pl[i] * f];
          if (prev) {
            var dd = angle(prev, p);
            push({ type: "LINE", x: prev[0], y: prev[1], dir: dd, r0: 0, r1: 0, len: dist(prev, p), endDir: dd });
          }
          prev = p;
        }
      } else if (t === "Chain") {
        warn("prvok Chain (reťaz bodov) sa nepodporuje");
      }
    });
    return hs;
  }

  // ---- niveleta --------------------------------------------------------------
  /* PVI s oblúkmi → úseky ako IfcAlignmentVerticalSegment (start = vzdialenosť
     od začiatku trasy, nie staničenie). Nesymetrický oblúk sa nahrádza
     parabolou cez celú jeho dĺžku. */
  function vertical(prof, f, staStart, warn) {
    var nodes = [];
    kids(prof).forEach(function (el) {
      var t = el.localName, n = nums(el.textContent);
      if (n.length < 2) return;
      var node = { sta: n[0] * f, z: n[1] * f, lin: 0, lout: 0, r: 0, circ: false };
      if (t === "ParaCurve") { var L = (attrNum(el, "length") || 0) * f; node.lin = node.lout = L / 2; }
      else if (t === "UnsymParaCurve") {
        node.lin = (attrNum(el, "lengthIn") || 0) * f; node.lout = (attrNum(el, "lengthOut") || 0) * f;
        if (node.lin !== node.lout) warn("nesymetrický výškový oblúk je nahradený parabolou");
      } else if (t === "CircCurve") {
        var Lc = (attrNum(el, "length") || 0) * f;
        node.lin = node.lout = Lc / 2; node.r = (attrNum(el, "radius") || 0) * f; node.circ = node.r > 0;
      } else if (t !== "PVI") return;
      nodes.push(node);
    });
    nodes.sort(function (a, b) { return a.sta - b.sta; });
    if (nodes.length < 2) return [];

    var g = [];
    for (var i = 0; i < nodes.length - 1; i++) {
      var ds = nodes[i + 1].sta - nodes[i].sta;
      g.push(ds > 0 ? (nodes[i + 1].z - nodes[i].z) / ds : 0);
    }
    var vs = [], cursor = nodes[0].sta;
    function tangent(to, k) {
      if (to - cursor > 1e-9) vs.push({ type: "CONSTANTGRADIENT", start: cursor - staStart, len: to - cursor,
        z0: nodes[k].z + g[k] * (cursor - nodes[k].sta), g0: g[k], g1: g[k], r: 0 });
    }
    for (var j = 1; j < nodes.length - 1; j++) {
      var nd = nodes[j], Lt = nd.lin + nd.lout;
      if (!(Lt > 0)) continue;
      var bc = nd.sta - nd.lin;
      tangent(bc, j - 1);
      vs.push({ type: nd.circ ? "CIRCULARARC" : "PARABOLICARC", start: bc - staStart, len: Lt,
        z0: nd.z - g[j - 1] * nd.lin, g0: g[j - 1], g1: g[j], r: nd.r });
      cursor = nd.sta + nd.lout;
    }
    tangent(nodes[nodes.length - 1].sta, nodes.length - 2);
    return vs;
  }

  // ---- návrhová rýchlosť ------------------------------------------------------
  /* Civil 3D: <Feature name="SpeedStation"> s vlastnosťami station a speed —
     rýchlosť platí od daného staničenia po ďalšiu zmenu. */
  function speeds(al, f) {
    var out = [];
    kids(al, "Feature").forEach(function (ft) {
      if (ft.getAttribute("name") !== "SpeedStation") return;
      var o = {};
      kids(ft, "Property").forEach(function (p) { o[p.getAttribute("label")] = +p.getAttribute("value"); });
      if (isFinite(o.speed) && o.speed > 0) out.push({ station: (isFinite(o.station) ? o.station : 0) * f, speed: o.speed });
    });
    return out.sort(function (a, b) { return a.station - b.station; });
  }

  // ---- povrchy TIN -----------------------------------------------------------
  function surface(el, f) {
    var def = kid(el, "Definition");
    if (!def) return null;
    var type = def.getAttribute("surfType") || "TIN";
    if (type.toUpperCase() !== "TIN") return { skip: type };
    var pnts = kid(def, "Pnts"), faces = kid(def, "Faces");
    if (!pnts || !faces) return null;
    var P = kids(pnts, "P"), idOf = new Map();
    var pos = new Float64Array(P.length * 3);
    P.forEach(function (p, i) {
      var n = nums(p.textContent);
      pos[i * 3] = n[1] * f; pos[i * 3 + 1] = n[0] * f; pos[i * 3 + 2] = (n[2] || 0) * f;
      idOf.set(p.getAttribute("id"), i);
    });
    var F = kids(faces, "F"), idx = new Uint32Array(F.length * 3), q = 0;
    F.forEach(function (fc) {
      if (fc.getAttribute("i") === "1") return;          // neviditeľný trojuholník (okraj, diera)
      var n = String(fc.textContent).trim().split(/\s+/);
      var a = idOf.get(n[0]), b = idOf.get(n[1]), c = idOf.get(n[2]);
      if (a == null || b == null || c == null) return;
      idx[q++] = a; idx[q++] = b; idx[q++] = c;
    });
    return { name: el.getAttribute("name") || "povrch", desc: el.getAttribute("desc") || "",
             pos: pos, idx: idx.slice(0, q), points: P.length, faces: q / 3 };
  }

  /* Hlavná funkcia — text súboru → { version, crs, alignments, surfaces, warnings }. */
  function parse(text, DOMParserImpl) {
    var Parser = DOMParserImpl || root.DOMParser;
    var doc = new Parser().parseFromString(text, "application/xml");
    var rootEl = doc.documentElement;
    if (!rootEl || doc.getElementsByTagName("parsererror").length) throw new Error("Súbor nie je platné XML.");
    if (rootEl.localName !== "LandXML") throw new Error("Súbor nie je LandXML (koreňový prvok je <" + rootEl.localName + ">).");

    var warnings = [];
    function warn(msg) { if (warnings.indexOf(msg) < 0) warnings.push(msg); }

    var units = kid(rootEl, "Units"), sys = units && (kid(units, "Metric") || kid(units, "Imperial"));
    var lu = sys && sys.getAttribute("linearUnit") || "meter";
    var f = LEN[lu];
    if (!f) { f = 1; warn("neznáma dĺžková jednotka „" + lu + "“ — berú sa metre"); }

    var cs = kid(rootEl, "CoordinateSystem"), crs = null;
    if (cs) {
      var epsg = cs.getAttribute("epsgCode") || cs.getAttribute("horizontalCoordinateSystemName") || "";
      var m = /(\d{4,6})/.exec(epsg);
      crs = { code: m ? "EPSG:" + m[1] : "", name: cs.getAttribute("name") || cs.getAttribute("desc") || epsg };
    }

    // pomenované body (CgPoints) — prvky trasy sa na ne môžu odkazovať
    var cgPts = {};
    all(rootEl, "CgPoint").forEach(function (p) { var n = p.getAttribute("name"); if (n) cgPts[n] = p.textContent; });

    var alignments = [];
    all(rootEl, "Alignment").forEach(function (al, i) {
      var cg = kid(al, "CoordGeom"); if (!cg) return;
      var staStart = (attrNum(al, "staStart") || 0) * f;
      var hs = horizontal(cg, f, cgPts, warn);
      if (!hs.length) return;
      var vs = [];
      var prof = kid(al, "Profile"), pa = prof && kid(prof, "ProfAlign");
      if (pa) vs = vertical(pa, f, staStart, warn);
      if (prof && kids(prof, "ProfAlign").length > 1) warn("trasa má viac nivelet — použije sa prvá");
      if (kid(al, "StaEquation")) warn("rovnice staničenia (StaEquation) sa neuplatňujú");
      alignments.push({ name: al.getAttribute("name") || "trasa " + (i + 1), desc: al.getAttribute("desc") || "",
        staStart: staStart, hs: hs, vs: vs, profile: pa ? pa.getAttribute("name") || "" : "",
        speeds: speeds(al, f), speedUnit: sys && sys.localName === "Imperial" ? "mph" : "km/h" });
    });

    var surfaces = [];
    all(rootEl, "Surface").forEach(function (el) {
      var s = surface(el, f);
      if (!s) return;
      if (s.skip) { warn("povrch typu " + s.skip + " sa nepodporuje"); return; }
      if (s.faces) surfaces.push(s);
    });

    return { version: rootEl.getAttribute("version") || "", crs: crs, unit: lu,
             alignments: alignments, surfaces: surfaces, warnings: warnings };
  }

  var api = { parse: parse };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LandXML = api;
})(typeof self !== "undefined" ? self : this);
