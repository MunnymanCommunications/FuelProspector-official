import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { GasStationLead } from '../types';

interface MapViewProps {
  leads: GasStationLead[];
  route: GasStationLead[];
  onSelectLead: (lead: GasStationLead) => void;
  onRouteCalculated?: (summary: { distance: number; time: number }) => void;
  mapsApiKey?: string;
}

// Straight-line distance in miles (fallback when no Maps API key)
const haversineDistance = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const R = 3958.8;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

// Load the Google Maps JS API once; resolves when DirectionsService is available.
// Deliberately avoids loading=async — that mode requires importLibrary("directions")
// which is not a recognized library name, breaking DirectionsService construction.
const loadMapsJsApi = (apiKey: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    if ((window as any).google?.maps?.DirectionsService) { resolve(); return; }
    const existing = document.getElementById('gmap-sdk');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Maps JS API failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.id = 'gmap-sdk';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Maps JS API failed to load'));
    document.head.appendChild(script);
  });
};

// Uses the Maps JS API DirectionsService (browser-native, no CORS issues).
// Batched at 25 stops (origin + 23 waypoints + destination); segments are stitched end-to-end.
const fetchDirectionsRoute = async (
  leads: GasStationLead[],
  apiKey: string
): Promise<{ latlngs: L.LatLng[]; distanceMiles: number; durationMinutes: number }> => {
  await loadMapsJsApi(apiKey);

  const ds = new (window as any).google.maps.DirectionsService();
  const MAX_WAYPOINTS = 23;
  const BATCH_SIZE = MAX_WAYPOINTS + 2;

  const allLatlngs: L.LatLng[] = [];
  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;

  let i = 0;
  while (i < leads.length - 1) {
    const batchEnd = Math.min(i + BATCH_SIZE - 1, leads.length - 1);
    const batch = leads.slice(i, batchEnd + 1);

    const waypoints = batch.slice(1, -1).map((l: GasStationLead) => ({
      location: { lat: l.lat, lng: l.lng },
      stopover: true
    }));

    const result = await new Promise<any>((resolve, reject) => {
      ds.route({
        origin: { lat: batch[0].lat, lng: batch[0].lng },
        destination: { lat: batch[batch.length - 1].lat, lng: batch[batch.length - 1].lng },
        waypoints,
        travelMode: 'DRIVING'
      }, (res: any, status: any) => {
        if (status === 'OK') resolve(res);
        else reject(new Error(`Directions API: ${status}`));
      });
    });

    const mapsRoute = result.routes[0];
    // overview_path is an array of google.maps.LatLng — convert directly to Leaflet LatLng
    const points: L.LatLng[] = mapsRoute.overview_path.map((p: any) => L.latLng(p.lat(), p.lng()));

    // Skip the first point on subsequent batches — it duplicates the previous batch's last point
    if (allLatlngs.length > 0 && points.length > 0) points.shift();
    allLatlngs.push(...points);

    for (const leg of mapsRoute.legs) {
      totalDistanceMeters += leg.distance.value;
      totalDurationSeconds += leg.duration.value;
    }

    i = batchEnd;
  }

  return {
    latlngs: allLatlngs,
    distanceMiles: totalDistanceMeters * 0.000621371,
    durationMinutes: totalDurationSeconds / 60
  };
};

const MapView: React.FC<MapViewProps> = ({ leads, route, onSelectLead, onRouteCalculated, mapsApiKey }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const routeLineRef = useRef<any>(null);

  useEffect(() => {
    if (!mapRef.current && mapContainerRef.current) {
      mapRef.current = L.map(mapContainerRef.current).setView([37.7749, -122.4194], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
      }).addTo(mapRef.current);
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  const createMarkerIcon = (colorClass: string, label?: string) => {
    const html = `
      <div class="marker-container">
        <svg viewBox="0 0 24 24" class="marker-svg ${colorClass}" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
        </svg>
        ${label ? `<div class="marker-label">${label}</div>` : ''}
      </div>
    `;
    return L.divIcon({
      className: 'custom-marker',
      html,
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32]
    });
  };

  // Re-render all markers whenever leads or route ordering changes
  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    if (leads.length > 0) {
      const group = L.featureGroup();
      leads.forEach(lead => {
        const colorClass =
          lead.confidence === 'high' ? 'marker-high' :
          lead.confidence === 'medium' ? 'marker-medium' : 'marker-low';
        const routeIdx = route.findIndex(r => r.id === lead.id);
        const label = routeIdx !== -1 ? (routeIdx + 1).toString() : undefined;

        const marker = L.marker([lead.lat, lead.lng], { icon: createMarkerIcon(colorClass, label) })
          .addTo(mapRef.current)
          .bindPopup(`
            <div class="p-1">
              <strong class="text-red-600">${lead.name}</strong><br/>
              <span class="text-xs text-slate-500">${lead.address}</span>
            </div>
          `)
          .on('click', () => onSelectLead(lead));

        markersRef.current.push(marker);
        group.addLayer(marker);
      });

      if (route.length === 0) {
        mapRef.current.fitBounds(group.getBounds(), { padding: [50, 50] });
      }
    }
  }, [leads, route, onSelectLead]);

  // Draw route — uses Google Maps JS API DirectionsService when key is available, Haversine polyline as fallback
  useEffect(() => {
    if (!mapRef.current) return;

    if (routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }

    if (route.length < 2) return;

    const drawPolyline = (latlngs: L.LatLng[], solid: boolean) => {
      const polyline = L.polyline(latlngs, {
        color: '#dc2626',
        opacity: 0.85,
        weight: 5,
        dashArray: solid ? undefined : '10, 7'
      }).addTo(mapRef.current);
      routeLineRef.current = polyline;
      mapRef.current.fitBounds(polyline.getBounds(), { padding: [60, 60] });
    };

    const fallbackHaversine = () => {
      drawPolyline(route.map(l => L.latLng(l.lat, l.lng)), false);
      let totalMiles = 0;
      for (let i = 0; i < route.length - 1; i++) {
        totalMiles += haversineDistance(route[i], route[i + 1]);
      }
      onRouteCalculated?.({ distance: totalMiles, time: (totalMiles / 25) * 60 });
    };

    if (mapsApiKey) {
      fetchDirectionsRoute(route, mapsApiKey)
        .then(({ latlngs, distanceMiles, durationMinutes }) => {
          drawPolyline(latlngs, true);
          onRouteCalculated?.({ distance: distanceMiles, time: durationMinutes });
        })
        .catch(err => {
          console.error('[FuelProspector] Directions API failed, using Haversine fallback:', err.message);
          fallbackHaversine();
        });
    } else {
      fallbackHaversine();
    }
  }, [route, onRouteCalculated, mapsApiKey]);

  return (
    <div
      ref={mapContainerRef}
      className="w-full h-full rounded-2xl shadow-xl border-4 border-white overflow-hidden relative"
    />
  );
};

export default MapView;
