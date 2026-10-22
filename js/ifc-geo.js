/* ifc-geo.js — georeferencovanie modelu a mapové podklady pre 3D prehliadač.
 * Funguje v Node aj v prehliadači (bez závislostí okrem proj4, ktorý sa podáva
 * zvonka — v prehliadači sa dotiahne z CDN až pri prvom použití).
 *
 * Reťazec súradníc:
 *   súradnice projektu IFC (m)  →  mapový systém (IfcMapConversion, S-JTSK…)
 *                               →  systém podkladu (EPSG:5514 pre ČÚZK/ZBGIS,
 *                                  EPSG:3857 pre dlaždice, WGS84 pre výšky)
 * Mapy z ČÚZK a ZBGIS sa vyžadujú priamo v S-JTSK (EPSG:5514), takže na model
 * v S-JTSK sedia bez prevodu.
 */
(function (root) {
  "use strict";

  // ---- súradnicové systémy -----------------------------------------------------
  // S-JTSK / Křovák East North; transformačný kľúč pre ČR (pre SR sa líši o
  // jednotky metrov — na výber podkladu a prevod do WGS84 to stačí, mapy sa
  // aj tak vyžadujú priamo v S-JTSK)
  var DEFS = {
    "EPSG:5514": "+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813972222222 +k=0.9999 " +
                 "+x_0=0 +y_0=0 +ellps=bessel +towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs",
    "EPSG:25833": "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    "EPSG:25834": "+proj=utm +zone=34 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    "EPSG:32633": "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs",
    "EPSG:32634": "+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs",
    "EPSG:3857": "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs"
  };
  var CRS_LABEL = {
    "EPSG:5514": "S-JTSK / Křovák East North (EPSG:5514)",
    "EPSG:25833": "ETRS89 / UTM 33N (EPSG:25833)",
    "EPSG:25834": "ETRS89 / UTM 34N (EPSG:25834)",
    "EPSG:32633": "WGS 84 / UTM 33N (EPSG:32633)",
    "EPSG:32634": "WGS 84 / UTM 34N (EPSG:32634)"
  };

  var P4 = null;
  function useProj4(p) {
    P4 = p;
    Object.keys(DEFS).forEach(function (k) { P4.defs(k, DEFS[k]); });
  }

  /* Kód systému z IfcProjectedCRS.Name (prípadne opisu) — „EPSG:5514“,
     „S-JTSK / Krovak East North“, ESRI 102067 a podobne. Neznámy → null. */
  function crsCode(name, description) {
    var s = String(name || "") + " " + String(description || "");
    var m = /EPSG\s*[:\s]\s*(\d{4,5})/i.exec(s) || /^\s*(\d{4,5})\s*$/.exec(String(name || ""));
    var code = m ? "EPSG:" + m[1] : null;
    if (code === "EPSG:102067" || /\b102067\b/.test(s)) code = "EPSG:5514";      // ESRI Krovak EN
    if (!code && /JTSK/i.test(s) && /East\s*North|5514/i.test(s)) code = "EPSG:5514";
    if (!code && /ETRS.*UTM.*33/i.test(s)) code = "EPSG:25833";
    if (!code && /ETRS.*UTM.*34/i.test(s)) code = "EPSG:25834";
    return code;
  }
  function supported(code) { return !!DEFS[code]; }

  /* Georeferencovanie: súradnice projektu ↔ mapový systém.
     E = E0 + s·(x·cos − y·sin), N = N0 + s·(x·sin + y·cos), H = H0 + z
     (rovnako ako IfcMapConversion; cos/sin z XAxisAbscissa/XAxisOrdinate). */
  function makeGeoref(o) {
    var len = Math.hypot(o.ax == null ? 1 : o.ax, o.ay || 0) || 1;
    var c = (o.ax == null ? 1 : o.ax) / len, sn = (o.ay || 0) / len, s = o.scale || 1;
    var g = {
      crs: o.crs, e0: +o.e0 || 0, n0: +o.n0 || 0, h0: +o.h0 || 0, cos: c, sin: sn, scale: s,
      source: o.source || "manual",
      rotationDeg: Math.atan2(sn, c) * 180 / Math.PI,
      toMap: function (x, y, z) {
        return [g.e0 + s * (x * c - y * sn), g.n0 + s * (x * sn + y * c), g.h0 + (z || 0)];
      },
      toLocal: function (E, N, H) {
        var dx = (E - g.e0) / s, dy = (N - g.n0) / s;
        return [dx * c + dy * sn, -dx * sn + dy * c, (H || 0) - g.h0];
      }
    };
    return g;
  }

  /* Súradnice modelu už ležia v S-JTSK (EPSG:5514 — záporné, Česko a Slovensko). */
  function looksLikeJtsk(x0, y0, x1, y1) {
    var inside = function (x, y) { return x > -960000 && x < -150000 && y > -1360000 && y < -900000; };
    return inside(x0, y0) && inside(x1, y1);
  }

  // ---- krajina — výber podkladu ČÚZK / ZBGIS -------------------------------------
  // hrubý obrys Slovenska (zemepisná dĺžka, šírka); presnosť na jednotky km stačí,
  // pri hranici sa dá krajina zvoliť ručne
  var SK = [[16.84, 48.37], [16.94, 48.62], [17.20, 48.87], [17.55, 48.80], [17.90, 49.00], [18.15, 49.28],
    [18.55, 49.50], [18.85, 49.52], [19.30, 49.53], [19.80, 49.20], [20.35, 49.42], [20.95, 49.35],
    [21.50, 49.43], [22.00, 49.25], [22.56, 49.08], [22.15, 48.40], [21.45, 48.57], [20.50, 48.48],
    [19.80, 48.16], [18.80, 47.83], [17.80, 47.75], [17.10, 48.00]];
  function inPoly(poly, x, y) {
    var ins = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins;
    }
    return ins;
  }
  function country(lon, lat) {
    if (inPoly(SK, lon, lat)) return "SK";
    if (lon > 12.0 && lon < 18.9 && lat > 48.5 && lat < 51.1) return "CZ";
    return "";
  }

  // ---- mapové služby ------------------------------------------------------------
  /* Podklady blízke Česku a Slovensku. WMS sa pýtajú v S-JTSK; názvy vrstiev sa
     zisťujú zo služby (GetCapabilities), aby nezáviseli od jej vnútorného číslovania. */
  var SOURCES = {
    ortofoto: {
      CZ: { kind: "wms", label: "Ortofotomapa ČÚZK", attr: "© ČÚZK",
            url: "https://ags.cuzk.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer", format: "image/jpeg" },
      SK: { kind: "wms", label: "Ortofotomozaika ZBGIS", attr: "© GKÚ Bratislava, NLC",
            url: "https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wms/service.svc/get", format: "image/jpeg" }
    },
    mapa: {
      CZ: { kind: "wms", label: "Základní topografická mapa ČÚZK", attr: "© ČÚZK",
            url: "https://ags.cuzk.cz/arcgis1/services/ZTM/MapServer/WMSServer", format: "image/png" },
      SK: { kind: "wms", label: "Mapa ZBGIS", attr: "© GKÚ Bratislava",
            url: "https://zbgisws.skgeodesy.sk/zbgis_wms_featureinfo/service.svc/get", format: "image/png" }
    },
    osm: { any: { kind: "xyz", label: "OpenStreetMap", attr: "© prispievatelia OpenStreetMap",
                  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19 } },
    terrarium: { any: { kind: "xyz", label: "Terrarium (EU-DEM / SRTM, ~30 m)", attr: "Mapzen Terrarium, AWS Open Data",
                        url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", maxZoom: 15 } }
  };

  function wmsGetMap(src, layers, crs, bbox, w, h) {
    // WMS 1.3.0 — EPSG:5514 má poradie osí východ, sever, takže BBOX = minE,minN,maxE,maxN
    var q = ["SERVICE=WMS", "VERSION=1.3.0", "REQUEST=GetMap", "STYLES=", "TRANSPARENT=FALSE",
      "LAYERS=" + encodeURIComponent(layers.join(",")), "CRS=" + encodeURIComponent(crs),
      "BBOX=" + bbox.map(function (v) { return v.toFixed(3); }).join(","),
      "WIDTH=" + w, "HEIGHT=" + h, "FORMAT=" + encodeURIComponent(src.format || "image/png")];
    return src.url + (src.url.indexOf("?") >= 0 ? "&" : "?") + q.join("&");
  }
  function wmsCapsUrl(src) {
    return src.url + (src.url.indexOf("?") >= 0 ? "&" : "?") + "SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0";
  }
  /* Z GetCapabilities: mená vrstiev na prvej úrovni pod koreňom (ak má koreň
     meno, stačí on) a podporované CRS. */
  function parseCaps(doc) {
    var all = doc.getElementsByTagName("Layer");
    if (!all.length) return { layers: [], crs: [] };
    var rootL = all[0], name = childText(rootL, "Name"), layers = [];
    if (name) layers = [name];
    else {
      for (var i = 0; i < rootL.childNodes.length; i++) {
        var c = rootL.childNodes[i];
        if (c.nodeName === "Layer" || c.localName === "Layer") {
          var n = childText(c, "Name");
          if (n) layers.push(n);
        }
      }
    }
    var crs = [];
    var cl = doc.getElementsByTagName("CRS");
    for (var j = 0; j < cl.length; j++) crs.push(String(cl[j].textContent || "").trim());
    return { layers: layers, crs: crs };
  }
  function childText(el, tag) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeName === tag || c.localName === tag) return String(c.textContent || "").trim();
    }
    return "";
  }

  // ---- dlaždice XYZ (Web Mercator) ---------------------------------------------
  var R = 6378137, HALF = Math.PI * R;
  function mercToTile(x, y, z) {               // súradnice EPSG:3857 → pixely dlaždicovej mriežky
    var n = Math.pow(2, z) * 256;
    return [(x + HALF) / (2 * HALF) * n, (HALF - y) / (2 * HALF) * n];
  }
  /* Najvyššie priblíženie, pri ktorom pokrytie obdĺžnika zaberie najviac maxTiles dlaždíc. */
  function zoomFor(minX, minY, maxX, maxY, maxZoom, maxTiles) {
    for (var z = maxZoom; z > 0; z--) {
      var a = mercToTile(minX, maxY, z), b = mercToTile(maxX, minY, z);
      var nx = Math.floor(b[0] / 256) - Math.floor(a[0] / 256) + 1, ny = Math.floor(b[1] / 256) - Math.floor(a[1] / 256) + 1;
      if (nx * ny <= maxTiles) return z;
    }
    return 1;
  }
  /* Výška z pixelu Terrarium: (R·256 + G + B/256) − 32768 m. */
  function terrariumHeight(r, g, b) { return r * 256 + g + b / 256 - 32768; }

  var api = {
    DEFS: DEFS, CRS_LABEL: CRS_LABEL, SOURCES: SOURCES,
    useProj4: useProj4, crsCode: crsCode, supported: supported, makeGeoref: makeGeoref,
    looksLikeJtsk: looksLikeJtsk, country: country,
    wmsGetMap: wmsGetMap, wmsCapsUrl: wmsCapsUrl, parseCaps: parseCaps,
    mercToTile: mercToTile, zoomFor: zoomFor, terrariumHeight: terrariumHeight,
    transform: function (from, to, xy) { return from === to ? xy.slice() : P4(from, to, xy); }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IFCGeo = api;
})(typeof self !== "undefined" ? self : this);
