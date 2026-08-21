import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import L, { type Map as LeafletMap, type Marker as LeafletMarker } from "leaflet";
import {
  Clock,
  Crosshair,
  Drop,
  Info,
  MapPin,
  Toilet,
  Wheelchair,
  X,
} from "@phosphor-icons/react";
import "leaflet/dist/leaflet.css";

type Filter = "all" | "water" | "toilet";
type SpotKind = Exclude<Filter, "all">;

type OsmElement = {
  id: number;
  type: "node" | "way";
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type Spot = {
  key: string;
  id: number;
  osmType: "node" | "way";
  kind: SpotKind;
  lat: number;
  lon: number;
  tags: Record<string, string>;
};

type CachedArea = {
  bounds: L.LatLngBounds;
  spots: Spot[];
  savedAt: number;
};

type OsmMapElement = OsmElement & { nodes?: number[] };

type SpotResult = {
  spots: Spot[];
  bounds: L.LatLngBounds;
};

const TOKYO_STATION: L.LatLngExpression = [35.681236, 139.767125];
const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
];
const OVERPASS_RETRY_KEY = "water-loo-overpass-retry-after";

function iconMarkup(kind: SpotKind) {
  return renderToStaticMarkup(
    kind === "water" ? (
      <Drop size={25} weight="fill" aria-hidden />
    ) : (
      <Toilet size={25} weight="fill" aria-hidden />
    ),
  );
}

function markerIcon(kind: SpotKind, selected = false) {
  return L.divIcon({
    className: "spot-marker-shell",
    html: `<span class="spot-marker spot-marker--${kind}${selected ? " is-selected" : ""}">${iconMarkup(kind)}</span>`,
    iconSize: selected ? [52, 58] : [44, 50],
    iconAnchor: selected ? [26, 56] : [22, 48],
    popupAnchor: [0, -48],
  });
}

function formatName(spot: Spot) {
  const fallback = spot.kind === "water" ? "名称未登録の水飲み場" : "名称未登録のトイレ";
  return spot.tags["name:ja"] || spot.tags.name || fallback;
}

function availability(tags: Record<string, string>) {
  if (tags.opening_hours === "24/7") return "24時間利用可";
  if (tags.opening_hours) return tags.opening_hours;
  return "利用時間の登録なし";
}

function normalizeElement(element: OsmElement): Spot | null {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat == null || lon == null) return null;
  const tags = element.tags ?? {};
  const kind: SpotKind = tags.amenity === "toilets" ? "toilet" : "water";
  return { key: `${element.type}-${element.id}`, id: element.id, osmType: element.type, kind, lat, lon, tags };
}

function buildQuery(bounds: L.LatLngBounds) {
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
    .map((value) => value.toFixed(6))
    .join(",");
  return `[out:json][timeout:20];(
    node["amenity"="drinking_water"](${bbox});
    node["man_made"="water_tap"](${bbox});
    node["amenity"="toilets"](${bbox});
    way["amenity"="toilets"](${bbox});
  );out center tags;`;
}

async function fetchOsmFallback(bounds: L.LatLngBounds, signal: AbortSignal): Promise<SpotResult> {
  const area = (bounds.getNorth() - bounds.getSouth()) * (bounds.getEast() - bounds.getWest());
  if (area > 0.25) throw new Error("OSM fallback bounds are too large");
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
    .map((value) => value.toFixed(6))
    .join(",");
  const response = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw new Error(`OSM ${response.status}`);
  const data = (await response.json()) as { elements?: OsmMapElement[] };
  const elements = data.elements ?? [];
  const nodes = new Map(
    elements
      .filter((element) => element.type === "node" && element.lat != null && element.lon != null)
      .map((element) => [element.id, { lat: element.lat!, lon: element.lon! }]),
  );
  const spots: Spot[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const isWater = element.type === "node" && (tags.amenity === "drinking_water" || tags.man_made === "water_tap");
    const isToilet = tags.amenity === "toilets" && (element.type === "node" || element.type === "way");
    if (!isWater && !isToilet) continue;
    let lat = element.lat;
    let lon = element.lon;
    if (element.type === "way") {
      const points = (element.nodes ?? [])
        .map((id) => nodes.get(id))
        .filter((point): point is { lat: number; lon: number } => Boolean(point));
      if (points.length) {
        lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
        lon = points.reduce((sum, point) => sum + point.lon, 0) / points.length;
      }
    }
    if (lat == null || lon == null) continue;
    if (!bounds.contains([lat, lon])) continue;
    spots.push({
      key: `${element.type}-${element.id}`,
      id: element.id,
      osmType: element.type,
      kind: isToilet ? "toilet" : "water",
      lat,
      lon,
      tags,
    });
  }
  return { spots, bounds };
}

async function fetchSpots(bounds: L.LatLngBounds, signal: AbortSignal): Promise<SpotResult> {
  const query = buildQuery(bounds);
  let lastError: unknown;
  const retryAfter = Number(window.sessionStorage.getItem(OVERPASS_RETRY_KEY) || 0);
  const endpoints = retryAfter > Date.now() ? [] : OVERPASS_ENDPOINTS;
  for (const [index, endpoint] of endpoints.entries()) {
    try {
      const timeoutSignal = AbortSignal.timeout(index === 0 ? 7000 : 12000);
      const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([signal, timeoutSignal]),
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const data = (await response.json()) as { elements?: OsmElement[] };
      const unique = new Map<string, Spot>();
      for (const element of data.elements ?? []) {
        const spot = normalizeElement(element);
        if (spot) unique.set(spot.key, spot);
      }
      window.sessionStorage.removeItem(OVERPASS_RETRY_KEY);
      return { spots: [...unique.values()], bounds };
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      window.sessionStorage.setItem(OVERPASS_RETRY_KEY, String(Date.now() + 15 * 60 * 1000));
    }
  }
  if (signal.aborted) throw lastError;
  return fetchOsmFallback(bounds, signal);
}

export default function Prototype() {
  const mapNodeRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<LeafletMarker | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestBoundsRef = useRef<L.LatLngBounds | null>(null);
  const loadTimerRef = useRef<number | null>(null);
  const cacheRef = useRef<CachedArea[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const selectedSpot = useMemo(
    () => spots.find((spot) => spot.key === selectedKey) ?? null,
    [selectedKey, spots],
  );

  const loadVisibleSpots = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const visibleBounds = map.getBounds();
    const now = Date.now();
    cacheRef.current = cacheRef.current.filter((entry) => now - entry.savedAt < 5 * 60 * 1000);
    const cached = cacheRef.current.find((entry) => entry.bounds.contains(visibleBounds));
    if (cached) {
      requestRef.current?.abort();
      requestRef.current = null;
      requestBoundsRef.current = null;
      setSpots(cached.spots);
      setLoading(false);
      setError(null);
      return;
    }
    if (requestRef.current && requestBoundsRef.current?.contains(visibleBounds)) {
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const requestedBounds = visibleBounds.pad(0.18);
    requestBoundsRef.current = requestedBounds;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSpots(requestedBounds, controller.signal);
      const nextSpots = result.spots;
      if (!controller.signal.aborted) {
        cacheRef.current = [
          { bounds: result.bounds, spots: nextSpots, savedAt: Date.now() },
          ...cacheRef.current,
        ].slice(0, 8);
        setSpots(nextSpots);
        setSelectedKey((current) => (nextSpots.some((spot) => spot.key === current) ? current : null));
      }
    } catch {
      if (!controller.signal.aborted) setError("スポットを読み込めませんでした。");
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        requestBoundsRef.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, []);

  const scheduleLoad = useCallback(() => {
    if (loadTimerRef.current) window.clearTimeout(loadTimerRef.current);
    loadTimerRef.current = window.setTimeout(loadVisibleSpots, 400);
  }, [loadVisibleSpots]);

  const locateUser = useCallback((moveMap = true, onSettled?: () => void) => {
    const map = mapRef.current;
    if (!map || !navigator.geolocation) {
      setError("この端末では位置情報を利用できません。");
      queueMicrotask(() => onSettled?.());
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (mapRef.current !== map) return;
        const point: L.LatLngExpression = [coords.latitude, coords.longitude];
        if (moveMap) map.setView(point, 16);
        userMarkerRef.current?.remove();
        userMarkerRef.current = L.marker(point, {
          zIndexOffset: 1000,
          icon: L.divIcon({
            className: "user-marker-shell",
            html: '<span class="user-marker"><span></span></span>',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        }).addTo(map);
        setLocating(false);
        setError(null);
        onSettled?.();
      },
      () => {
        if (mapRef.current !== map) return;
        if (moveMap) map.setView(TOKYO_STATION, 15);
        setLocating(false);
        if (!moveMap) setError("現在地を取得できませんでした。");
        onSettled?.();
      },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 },
    );
  }, []);

  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current) return;
    const map = L.map(mapNodeRef.current, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    }).setView(TOKYO_STATION, 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    map.on("moveend", scheduleLoad);
    map.whenReady(() => {
      locateUser(true, loadVisibleSpots);
    });
    return () => {
      requestRef.current?.abort();
      if (loadTimerRef.current) window.clearTimeout(loadTimerRef.current);
      map.off("moveend", scheduleLoad);
      map.remove();
      mapRef.current = null;
    };
  }, [loadVisibleSpots, locateUser, scheduleLoad]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    spots
      .filter((spot) => filter === "all" || spot.kind === filter)
      .forEach((spot) => {
        L.marker([spot.lat, spot.lon], { icon: markerIcon(spot.kind, spot.key === selectedKey) })
          .on("click", () => setSelectedKey(spot.key))
          .addTo(layer);
      });
  }, [filter, selectedKey, spots]);

  const visibleCount = spots.filter((spot) => filter === "all" || spot.kind === filter).length;

  return (
    <main className="map-app" data-testid="app-screen" aria-label="Water & Loo Map">
      <div ref={mapNodeRef} className="map-canvas" data-testid="map-canvas" />

      <header className="brand-panel">
        <span className="brand-icon"><Drop size={27} weight="duotone" /></span>
        <span>
          <strong>Water &amp; Loo Map</strong>
          <small>水飲み場とトイレを、すぐそばに。</small>
        </span>
      </header>

      <div className="map-status" aria-live="polite">
        {loading ? <><span className="spinner" />検索中</> : `${visibleCount}件を表示`}
      </div>

      {error && (
        <button className="error-toast" onClick={loadVisibleSpots} aria-label="スポット検索を再試行">
          <Info size={18} weight="fill" /> <span>{error}<b> タップして再試行</b></span> <Crosshair size={16} />
        </button>
      )}

      <button
        className={`locate-button${locating ? " is-loading" : ""}`}
        onClick={() => locateUser(true)}
        aria-label="現在地へ移動"
      >
        <Crosshair size={28} weight="bold" />
      </button>

      {selectedSpot && (
        <section className="spot-sheet" aria-label="スポット詳細">
          <span className={`detail-kind-icon detail-kind-icon--${selectedSpot.kind}`}>
            {selectedSpot.kind === "water" ? <Drop size={28} weight="fill" /> : <Toilet size={28} weight="fill" />}
          </span>
          <button className="close-sheet" onClick={() => setSelectedKey(null)} aria-label="詳細を閉じる"><X size={19} /></button>
          <div className="detail-heading">
            <strong>{formatName(selectedSpot)}</strong>
            <span className={`kind-label kind-label--${selectedSpot.kind}`}>
              {selectedSpot.kind === "water" ? "水飲み場" : "トイレ"}
            </span>
          </div>
          <div className="detail-grid">
            <span><Clock size={17} />利用時間</span><b>{availability(selectedSpot.tags)}</b>
            <span><Wheelchair size={17} />車いす対応</span><b>{selectedSpot.tags.wheelchair === "yes" ? "対応" : "情報なし"}</b>
            <span><MapPin size={17} />OSM ID</span>
            <a href={`https://www.openstreetmap.org/${selectedSpot.osmType}/${selectedSpot.id}`} target="_blank" rel="noreferrer">
              {selectedSpot.osmType}/{selectedSpot.id}
            </a>
          </div>
        </section>
      )}

      <nav className="filter-bar" aria-label="スポット表示フィルター">
        {([
          ["all", "すべて", null],
          ["water", "水飲み場", <Drop size={20} weight="fill" key="drop" />],
          ["toilet", "トイレ", <Toilet size={20} weight="fill" key="toilet" />],
        ] as const).map(([value, label, icon]) => (
          <button
            key={value}
            className={`filter-button filter-button--${value}${filter === value ? " is-active" : ""}`}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setSelectedKey((current) => {
                const selected = spots.find((spot) => spot.key === current);
                return value === "all" || selected?.kind === value ? current : null;
              });
            }}
          >
            {icon}{label}
          </button>
        ))}
      </nav>
    </main>
  );
}
