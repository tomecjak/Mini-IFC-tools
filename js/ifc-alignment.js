/* ifc-alignment.js — trasa (IfcAlignment) podľa IFC 4.3 a jej staničenie.
 * Funguje v Node aj v prehliadači (bez závislostí), pracuje nad čitateľom entít:
 *
 *   reader.line(id)      → entita v tvare, aký vracia web-ifc GetLine(…, false)
 *                          (pomenované atribúty, odkaz = {type:5, value:id})
 *   reader.ids(typeName) → zoznam ID entít danej triedy, napr. "IFCALIGNMENT"
 *
 * Trasa sa počíta z „business logic“ — z návrhových parametrov úsekov
 * (IfcAlignmentHorizontalSegment, IfcAlignmentVerticalSegment,
 * IfcAlignmentCantSegment), nie z teselovanej geometrie. Smerové prvky:
 * priamka, kružnicový oblúk, klotoida a ďalšie prechodnice (Bloss, kosínusová,
 * sínusová, Helmert, Viedenský oblúk; kubická parabola sa nahrádza klotoidou).
 * Výškové prvky: konštantný sklon, parabolický a kružnicový oblúk.
 *
 * Súradnice výsledku sú v metroch v súradnicovom systéme projektu (IFC: Z hore),
 * vrátane umiestnenia trasy (ObjectPlacement). Staničenie vychádza z IfcReferent
 * s Pset_Stationing.Station; bez neho sa začína nulou.
 */
(function (root) {
  "use strict";

  // ---- čítanie hodnôt z entít web-ifc ----------------------------------------
  function val(x) {
    if (x == null) return null;
    if (typeof x !== "object") return x;
    if (x.value !== undefined) return x.value;
    if (x._representationValue !== undefined) return x._representationValue;
    return null;
  }
  function num(x, def) {
    var v = val(x);
    if (v == null || v === "") return def === undefined ? null : def;
    v = +v;
    return isFinite(v) ? v : (def === undefined ? null : def);
  }
  function ref(x) { return x && x.type === 5 ? x.value : null; }
  function refs(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(ref).filter(function (r) { return r != null; });
  }
  function str(x) { var v = val(x); return v == null ? "" : String(v); }

  // ---- jednotky ----------------------------------------------------------------
  var PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3,
    HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6,
    NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18 };

  /* Prevod dĺžkovej jednotky súboru na metre a uhlovej na radiány. */
  function units(reader) {
    var out = { length: 1, angle: 1, lengthName: "m" };
    var proj = reader.ids("IFCPROJECT")[0];
    if (proj == null) return out;
    var p = reader.line(proj);
    var ua = p && ref(p.UnitsInContext);
    var u = ua != null ? reader.line(ua) : null;
    if (!u) return out;
    refs(u.Units).forEach(function (id) {
      var e = reader.line(id); if (!e) return;
      var t = str(e.UnitType);
      if (t !== "LENGTHUNIT" && t !== "PLANEANGLEUNIT") return;
      var f = 1;
      if (e.Prefix !== undefined && e.Name && str(e.Name) && !e.ConversionFactor) {
        f = PREFIX[str(e.Prefix)] || 1;                    // IfcSIUnit
      } else if (e.ConversionFactor) {                     // IfcConversionBasedUnit
        var m = reader.line(ref(e.ConversionFactor));
        f = m ? num(m.ValueComponent, 1) : 1;
        var base = m && reader.line(ref(m.UnitComponent));
        if (base && base.Prefix !== undefined) f *= PREFIX[str(base.Prefix)] || 1;
      }
      if (t === "LENGTHUNIT") {
        out.length = f;
        out.lengthName = f === 1 ? "m" : f === 1e-3 ? "mm" : f === 1e-2 ? "cm" : (str(e.Name) || "").toLowerCase();
      } else out.angle = f;
    });
    return out;
  }

  // ---- umiestnenie (IfcLocalPlacement → matica 4×4, po stĺpcoch) ------------
  function mul(a, b) {
    var r = new Array(16);
    for (var c = 0; c < 4; c++) for (var rI = 0; rI < 4; rI++) {
      var s = 0;
      for (var k = 0; k < 4; k++) s += a[k * 4 + rI] * b[c * 4 + k];
      r[c * 4 + rI] = s;
    }
    return r;
  }
  var IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  function coords(reader, id) {
    var e = id != null ? reader.line(id) : null;
    if (!e) return null;
    var c = e.Coordinates || e.DirectionRatios;
    return Array.isArray(c) ? c.map(function (v) { return num(v, 0); }) : null;
  }
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

  function axisMatrix(reader, id, ls) {
    var e = reader.line(id);
    if (!e) return IDENT.slice();
    var loc = coords(reader, ref(e.Location)) || [0, 0, 0];
    while (loc.length < 3) loc.push(0);
    var z = coords(reader, ref(e.Axis)) || [0, 0, 1];
    var x = coords(reader, ref(e.RefDirection)) || [1, 0, 0];
    if (z.length < 3) z = [0, 0, 1];
    while (x.length < 3) x.push(0);
    z = norm(z);
    var y = norm(cross(z, x)); x = cross(y, z);
    return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0,
            loc[0] * ls, loc[1] * ls, loc[2] * ls, 1];
  }

  /* Celý reťazec IfcLocalPlacement až po koreň. Lineárne umiestnenie
     (IfcLinearPlacement) použije svoju kartézsku náhradu, ak ju má. */
  function placementMatrix(reader, id, ls, depth) {
    if (id == null || (depth || 0) > 64) return IDENT.slice();
    var e = reader.line(id);
    if (!e) return IDENT.slice();
    var rel = ref(e.RelativePlacement);
    var relEnt = rel != null ? reader.line(rel) : null;
    var local;
    if (relEnt && relEnt.Location !== undefined && relEnt.Axis !== undefined) local = axisMatrix(reader, rel, ls);
    else if (e.CartesianPosition && ref(e.CartesianPosition) != null) local = axisMatrix(reader, ref(e.CartesianPosition), ls);
    else if (relEnt && relEnt.Location !== undefined) {           // 2D umiestnenie
      var l2 = coords(reader, ref(relEnt.Location)) || [0, 0];
      var d2 = coords(reader, ref(relEnt.RefDirection)) || [1, 0];
      var a = Math.atan2(d2[1], d2[0]);
      local = [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, l2[0] * ls, l2[1] * ls, 0, 1];
    } else local = IDENT.slice();
    var parent = ref(e.PlacementRelTo);
    return parent != null ? mul(placementMatrix(reader, parent, ls, (depth || 0) + 1), local) : local;
  }
  function apply(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  }
  function applyDir(m, d) {
    return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
            m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
            m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
  }

  // ---- smerové prvky -----------------------------------------------------------
  /* Tvar priebehu krivosti prechodnice: k(t) = k0 + (k1 − k0)·f(t), t ∈ ⟨0,1⟩.
     F(t) = ∫₀ᵗ f — z neho sa počíta smerník bez numerickej integrácie. */
  var SHAPES = {
    LINE:         function () { return 0; },
    CIRCULARARC:  function () { return 0; },
    CLOTHOID:     function (t) { return t * t / 2; },
    CUBIC:        function (t) { return t * t / 2; },
    BLOSSCURVE:   function (t) { return t * t * t - t * t * t * t / 2; },
    COSINECURVE:  function (t) { return t / 2 - Math.sin(Math.PI * t) / (2 * Math.PI); },
    SINECURVE:    function (t) { return t * t / 2 + (Math.cos(2 * Math.PI * t) - 1) / (4 * Math.PI * Math.PI); },
    HELMERTCURVE: function (t) {
      if (t <= 0.5) return 2 * t * t * t / 3;
      return 1 / 12 + (t - 0.5) + (2 / 3) * (Math.pow(1 - t, 3) - 0.125);
    },
    VIENNESEBEND: function (t) {
      var t5 = Math.pow(t, 5);
      return 7 * t5 - 14 * t5 * t + 10 * t5 * t * t - 2.5 * t5 * t * t * t;
    }
  };
  var SHAPE_F = {   // samotné f(t) — krivosť v danom mieste (na zobrazenie polomeru)
    CLOTHOID: function (t) { return t; }, CUBIC: function (t) { return t; },
    BLOSSCURVE: function (t) { return 3 * t * t - 2 * t * t * t; },
    COSINECURVE: function (t) { return (1 - Math.cos(Math.PI * t)) / 2; },
    SINECURVE: function (t) { return t - Math.sin(2 * Math.PI * t) / (2 * Math.PI); },
    HELMERTCURVE: function (t) { return t <= 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); },
    VIENNESEBEND: function (t) { var t4 = t * t * t * t; return 35 * t4 - 84 * t4 * t + 70 * t4 * t * t - 20 * t4 * t * t * t; }
  };
  var GL_X = [-0.9061798459386640, -0.5384693101056831, 0, 0.5384693101056831, 0.9061798459386640];
  var GL_W = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];

  function hSegment(seg) {
    var k0 = seg.r0 ? 1 / seg.r0 : 0, k1 = seg.r1 ? 1 / seg.r1 : 0;
    var L = seg.len, F = SHAPES[seg.type] || SHAPES.CLOTHOID;
    if (seg.type === "CIRCULARARC") k1 = k0;
    if (seg.type === "LINE") { k0 = 0; k1 = 0; }
    function heading(s) { return seg.dir + k0 * s + (L > 0 ? (k1 - k0) * L * F(s / L) : 0); }
    function curvature(s) {
      if (seg.type === "LINE") return 0;
      if (seg.type === "CIRCULARARC") return k0;
      var f = SHAPE_F[seg.type] || SHAPE_F.CLOTHOID;
      return k0 + (k1 - k0) * f(L > 0 ? s / L : 0);
    }
    function at(s) {
      s = Math.max(0, Math.min(L, s));
      var x = seg.x, y = seg.y;
      if (seg.type === "LINE" || (k0 === 0 && k1 === 0)) {
        x += s * Math.cos(seg.dir); y += s * Math.sin(seg.dir);
      } else if (seg.type === "CIRCULARARC") {
        x += (Math.sin(seg.dir + k0 * s) - Math.sin(seg.dir)) / k0;
        y -= (Math.cos(seg.dir + k0 * s) - Math.cos(seg.dir)) / k0;
      } else {
        // Gauss–Legendre po krokoch najviac 5 m — pri prechodniciach presné na mikrometre
        var n = Math.max(1, Math.ceil(s / 5)), h = s / n;
        for (var i = 0; i < n; i++) {
          var a = i * h;
          for (var j = 0; j < 5; j++) {
            var u = a + h / 2 * (1 + GL_X[j]), th = heading(u);
            x += h / 2 * GL_W[j] * Math.cos(th);
            y += h / 2 * GL_W[j] * Math.sin(th);
          }
        }
      }
      return { x: x, y: y, heading: heading(s), curvature: curvature(s) };
    }
    return at;
  }

  // ---- výškové prvky -----------------------------------------------------------
  function vAt(seg, d) {
    var u = Math.max(0, Math.min(seg.len, d - seg.start)), g0 = seg.g0, g1 = seg.g1, L = seg.len;
    if (seg.type === "CIRCULARARC" && seg.r) {
      var R = Math.abs(seg.r), s = (g1 - g0) >= 0 ? 1 : -1;
      var a0 = Math.atan(g0);
      var uc = -s * R * Math.sin(a0), zc = seg.z0 + s * R * Math.cos(a0);
      var q = R * R - (u - uc) * (u - uc);
      if (q > 0) {
        var sq = Math.sqrt(q);
        return { z: zc - s * sq, g: s * (u - uc) / sq };
      }
    }
    if (seg.type === "CONSTANTGRADIENT" || L <= 0) return { z: seg.z0 + g0 * u, g: g0 };
    // parabolický oblúk (aj náhrada pre vertikálnu klotoidu)
    return { z: seg.z0 + g0 * u + (g1 - g0) * u * u / (2 * L), g: g0 + (g1 - g0) * u / L };
  }

  // ---- prevýšenie (cant) ---------------------------------------------------------
  function cantAt(segs, d) {
    for (var i = 0; i < segs.length; i++) {
      var c = segs[i];
      if (d < c.start - 1e-9 || d > c.start + c.len + 1e-9) continue;
      var t = c.len > 0 ? (d - c.start) / c.len : 0;
      var f = c.type === "CONSTANTCANT" ? 0 : c.type === "LINEARTRANSITION" ? t :
        (SHAPE_F[c.type] || SHAPE_F.CLOTHOID)(t);
      return { left: c.l0 + (c.l1 - c.l0) * f, right: c.r0 + (c.r1 - c.r0) * f, type: c.type };
    }
    return null;
  }

  // ---- zostavenie trasy ----------------------------------------------------------
  function nestedChildren(reader, nests, parent) {
    var out = [];
    (nests.get(parent) || []).forEach(function (list) { out.push.apply(out, list); });
    return out;
  }

  function readAlignments(reader) {
    var U = units(reader), ls = U.length, as = U.angle;

    // väzby IfcRelNests: rodič → zoradené zoznamy detí
    var nests = new Map();
    reader.ids("IFCRELNESTS").forEach(function (id) {
      var r = reader.line(id); if (!r) return;
      var p = ref(r.RelatingObject); if (p == null) return;
      if (!nests.has(p)) nests.set(p, []);
      nests.get(p).push(refs(r.RelatedObjects));
    });

    // staničenie z IfcReferent (Pset_Stationing.Station)
    var referents = reader.ids("IFCREFERENT");
    var stationOf = new Map();
    if (referents.length) {
      var refSet = new Set(referents);
      reader.ids("IFCRELDEFINESBYPROPERTIES").forEach(function (id) {
        var r = reader.line(id); if (!r) return;
        var objs = refs(r.RelatedObjects).filter(function (o) { return refSet.has(o); });
        if (!objs.length) return;
        var ps = reader.line(ref(r.RelatingPropertyDefinition));
        if (!ps || str(ps.Name) !== "Pset_Stationing") return;
        refs(ps.HasProperties).forEach(function (pid) {
          var p = reader.line(pid);
          if (p && str(p.Name) === "Station") {
            var v = num(p.NominalValue);
            if (v != null) objs.forEach(function (o) { stationOf.set(o, v * ls); });
          }
        });
      });
    }
    function referentDistance(id) {
      var e = reader.line(id); if (!e) return null;
      var pl = reader.line(ref(e.ObjectPlacement));
      var rp = pl && reader.line(ref(pl.RelativePlacement));
      var loc = rp && reader.line(ref(rp.Location));
      return loc && loc.DistanceAlong !== undefined ? num(loc.DistanceAlong, 0) * ls : null;
    }

    var out = [];
    reader.ids("IFCALIGNMENT").forEach(function (aid) {
      var A = reader.line(aid); if (!A) return;
      var kids = nestedChildren(reader, nests, aid).map(function (id) { return { id: id, e: reader.line(id) }; });
      var H = null, V = null, C = null, refsIn = [];
      kids.forEach(function (k) {
        if (!k.e) return;
        if (k.e.type !== undefined && reader.typeName) {
          var tn = reader.typeName(k.e.type);
          if (tn === "IFCALIGNMENTHORIZONTAL") H = k.id;
          else if (tn === "IFCALIGNMENTVERTICAL") { if (V == null) V = k.id; }
          else if (tn === "IFCALIGNMENTCANT") C = k;
          else if (tn === "IFCREFERENT") refsIn.push(k.id);
        }
      });
      if (H == null) return;

      function designParams(parent) {
        return nestedChildren(reader, nests, parent).map(function (sid) {
          var s = reader.line(sid);
          return s ? reader.line(ref(s.DesignParameters)) : null;
        }).filter(Boolean);
      }

      // smerové úseky
      var hs = [], dist = 0;
      designParams(H).forEach(function (p) {
        var pt = coords(reader, ref(p.StartPoint)) || [0, 0];
        var seg = {
          type: str(p.PredefinedType) || "LINE",
          x: pt[0] * ls, y: pt[1] * ls, dir: num(p.StartDirection, 0) * as,
          r0: num(p.StartRadiusOfCurvature, 0) * ls, r1: num(p.EndRadiusOfCurvature, 0) * ls,
          len: Math.abs(num(p.SegmentLength, 0)) * ls, start: dist
        };
        if (seg.len <= 0) return;               // koncový úsek nulovej dĺžky (len značka konca)
        seg.at = hSegment(seg);
        hs.push(seg);
        dist += seg.len;
      });
      if (!hs.length) return;

      // výškové úseky
      var vs = [];
      if (V != null) designParams(V).forEach(function (p) {
        var seg = {
          type: str(p.PredefinedType) || "CONSTANTGRADIENT",
          start: num(p.StartDistAlong, 0) * ls, len: num(p.HorizontalLength, 0) * ls,
          z0: num(p.StartHeight, 0) * ls, g0: num(p.StartGradient, 0), g1: num(p.EndGradient, 0),
          r: num(p.RadiusOfCurvature, 0) * ls
        };
        if (seg.len > 0) vs.push(seg);
      });
      vs.sort(function (a, b) { return a.start - b.start; });

      // prevýšenie
      var cs = [], railHead = null;
      if (C) {
        railHead = num(C.e.RailHeadDistance);
        if (railHead != null) railHead *= ls;
        designParams(C.id).forEach(function (p) {
          var seg = {
            type: str(p.PredefinedType) || "CONSTANTCANT",
            start: num(p.StartDistAlong, 0) * ls, len: num(p.HorizontalLength, 0) * ls,
            l0: num(p.StartCantLeft, 0) * ls, r0: num(p.StartCantRight, 0) * ls
          };
          seg.l1 = p.EndCantLeft != null ? num(p.EndCantLeft, 0) * ls : seg.l0;
          seg.r1 = p.EndCantRight != null ? num(p.EndCantRight, 0) * ls : seg.r0;
          if (seg.len > 0) cs.push(seg);
        });
      }

      // začiatočné staničenie — referent s najmenšou vzdialenosťou od začiatku
      var startStation = 0, bestD = Infinity;
      refsIn.forEach(function (rid) {
        if (!stationOf.has(rid)) return;
        var d = referentDistance(rid);
        if (d == null) d = 0;
        if (d < bestD) { bestD = d; startStation = stationOf.get(rid) - d; }
      });

      var M = placementMatrix(reader, ref(A.ObjectPlacement), ls);
      out.push(makeAlignment({
        id: aid, name: str(A.Name), guid: str(A.GlobalId),
        hs: hs, vs: vs, cs: cs, length: dist, startStation: startStation,
        railHead: railHead, matrix: M, hasVertical: vs.length > 0
      }));
    });
    return out;
  }

  function makeAlignment(a) {
    function hAt(d) {
      var hs = a.hs, lo = 0, hi = hs.length - 1;
      if (d <= 0) return { seg: hs[0], p: hs[0].at(Math.max(d, 0)) };
      while (lo < hi) {                      // binárne hľadanie úseku
        var mid = (lo + hi + 1) >> 1;
        if (hs[mid].start <= d) lo = mid; else hi = mid - 1;
      }
      var s = hs[lo];
      return { seg: s, p: s.at(d - s.start) };
    }
    function zAt(d) {
      var vs = a.vs;
      if (!vs.length) return null;
      var s = vs[0];
      for (var i = 0; i < vs.length; i++) { if (vs[i].start <= d + 1e-9) s = vs[i]; else break; }
      var r = vAt(s, d);
      r.seg = s;
      return r;
    }

    /* Bod trasy vo vzdialenosti d od začiatku (nie staničenie!).
       Vracia polohu v súradniciach projektu (m, Z hore), jednotkový smer
       v pôdorystu, sklon nivelety, prvky a prevýšenie v danom mieste. */
    function pointAt(d) {
      d = Math.max(0, Math.min(a.length, d));
      var h = hAt(d), v = zAt(d);
      var local = [h.p.x, h.p.y, v ? v.z : 0];
      var P = apply(a.matrix, local);
      var T = applyDir(a.matrix, [Math.cos(h.p.heading), Math.sin(h.p.heading), 0]);
      var tl = Math.hypot(T[0], T[1]) || 1;
      return {
        dist: d, station: a.startStation + d,
        x: P[0], y: P[1], z: P[2], hasZ: !!v,
        tx: T[0] / tl, ty: T[1] / tl,
        gradient: v ? v.g : 0,
        hType: h.seg.type, radius: h.p.curvature ? 1 / h.p.curvature : 0,
        vType: v ? v.seg.type : "", vRadius: v && v.seg.r ? v.seg.r : 0,
        cant: cantAt(a.cs, d)
      };
    }

    /* Zahustené body trasy na kreslenie — hranice prvkov sú zachované. */
    function sample(maxStep) {
      maxStep = maxStep || 2;
      var ds = [];
      a.hs.forEach(function (s) {
        var n = Math.max(1, Math.ceil(s.len / (s.type === "LINE" ? Math.max(maxStep, s.len / 4) : maxStep)));
        for (var i = 0; i < n; i++) ds.push(s.start + s.len * i / n);
      });
      a.vs.forEach(function (s) {
        var n = s.type === "CONSTANTGRADIENT" ? 1 : Math.max(1, Math.ceil(s.len / maxStep));
        for (var i = 0; i <= n; i++) ds.push(s.start + s.len * i / n);
      });
      ds.push(a.length);
      ds = ds.filter(function (d) { return d >= 0 && d <= a.length; }).sort(function (x, y) { return x - y; });
      var pts = [], last = -1;
      ds.forEach(function (d) { if (d - last > 1e-6) { pts.push(pointAt(d)); last = d; } });
      return pts;
    }

    return {
      id: a.id, name: a.name, guid: a.guid,
      length: a.length, startStation: a.startStation, endStation: a.startStation + a.length,
      hasVertical: a.hasVertical, hasCant: a.cs.length > 0, railHead: a.railHead,
      horizontal: a.hs.map(function (s) { return { type: s.type, start: s.start, length: s.len, r0: s.r0, r1: s.r1 }; }),
      vertical: a.vs.map(function (s) { return { type: s.type, start: s.start, length: s.len, g0: s.g0, g1: s.g1, r: s.r }; }),
      pointAt: pointAt,
      atStation: function (st) { return pointAt(st - a.startStation); },
      sample: sample
    };
  }

  /* Trasa z hotových úsekov (napr. z LandXML, js/landxml.js) — rovnaké jadro ako pri IFC.
     o.hs: [{type, x, y, dir, r0, r1, len}] — m a rad, polomer + doľava, − doprava, 0 = priamka;
     o.vs: [{type, start, len, z0, g0, g1, r}] — start je vzdialenosť od začiatku trasy;
     o.matrix: umiestnenie (4×4 po stĺpcoch), ktorým sa body prevedú do súradníc projektu. */
  function buildAlignment(o) {
    var hs = [], dist = 0;
    (o.hs || []).forEach(function (s) {
      if (!(s.len > 0)) return;
      var seg = { type: s.type || "LINE", x: s.x, y: s.y, dir: s.dir, r0: s.r0 || 0, r1: s.r1 || 0, len: s.len, start: dist };
      seg.at = hSegment(seg);
      hs.push(seg);
      dist += seg.len;
    });
    if (!hs.length) return null;
    var vs = (o.vs || []).filter(function (s) { return s.len > 0; })
      .map(function (s) { return { type: s.type, start: s.start, len: s.len, z0: s.z0, g0: s.g0, g1: s.g1, r: s.r || 0 }; })
      .sort(function (a, b) { return a.start - b.start; });
    return makeAlignment({
      id: o.id == null ? null : o.id, name: o.name || "", guid: "",
      hs: hs, vs: vs, cs: [], length: dist, startStation: o.startStation || 0,
      railHead: null, matrix: o.matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      hasVertical: vs.length > 0
    });
  }

  /* Staničenie v tvare „km 1,234.567“ — kilometre, za čiarkou metre. */
  function formatStation(st, dec) {
    dec = dec == null ? 3 : dec;
    var neg = st < 0; st = Math.abs(st);
    var km = Math.floor(st / 1000 + 1e-12), m = st - km * 1000;
    if (+m.toFixed(dec) >= 1000) { km += 1; m = 0; }
    var ms = m.toFixed(dec);
    var intPart = ms.split(".")[0];
    while (intPart.length < 3) { ms = "0" + ms; intPart = "0" + intPart; }
    return (neg ? "−" : "") + km + "," + ms;
  }
  /* Rozpozná „1,234.5“, „1+234.5“, „km 1,234 5“ aj obyčajné metre „1234.5“. */
  function parseStation(text) {
    var s = String(text || "").trim().replace(/^km\s*/i, "").replace(/\s+/g, "").replace(/−/g, "-");
    if (!s) return null;
    var neg = s[0] === "-"; if (neg) s = s.slice(1);
    var m = /^(\d+)[+,](\d{3}(?:\.\d*)?)$/.exec(s) || /^(\d+)\+(\d+(?:\.\d*)?)$/.exec(s), v;
    if (m) v = +m[1] * 1000 + +m[2];
    else if (/^\d+(?:[.,]\d*)?$/.test(s)) v = +s.replace(",", ".");
    else return null;
    return isFinite(v) ? (neg ? -v : v) : null;
  }

  var api = {
    readAlignments: readAlignments,
    buildAlignment: buildAlignment,
    units: units,
    placementMatrix: placementMatrix,
    formatStation: formatStation,
    parseStation: parseStation
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IFCAlignment = api;
})(typeof self !== "undefined" ? self : this);
