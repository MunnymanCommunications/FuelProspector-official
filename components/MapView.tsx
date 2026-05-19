import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { GasStationLead } from '../types';

interface MapViewProps {
  leads: GasStationLead[];
  route: GasStationLead[];
  onSelectLead: (lead: GasStationLead) => void;
  onRouteCalculated?: (summary: { distance: number; time: number }) => void;
}

// Straight-line distance in miles between two lat/lng points
const haversineDistance = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const R = 3958.8;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const MapView: React.FC<MapViewProps> = ({ leads, route, onSelectLead, onRouteCalculated }) => {
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
              <strong class="text-indigo-600">${lead.name}</strong><br/>
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

  // Draw route polyline — no external routing service, works for any number of stops
  useEffect(() => {
    if (!mapRef.current) return;

    if (routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }

    if (route.length > 1) {
      const latlngs = route.map(l => L.latLng(l.lat, l.lng));
      const polyline = L.polyline(latlngs, {
        color: '#6366f1',
        opacity: 0.85,
        weight: 5,
        dashArray: '10, 7'
      }).addTo(mapRef.current);

      routeLineRef.current = polyline;
      mapRef.current.fitBounds(polyline.getBounds(), { padding: [60, 60] });

      if (onRouteCalculated) {
        let totalMiles = 0;
        for (let i = 0; i < route.length - 1; i++) {
          totalMiles += haversineDistance(
            { lat: route[i].lat, lng: route[i].lng },
            { lat: route[i + 1].lat, lng: route[i + 1].lng }
          );
        }
        onRouteCalculated({
          distance: totalMiles,
          time: (totalMiles / 25) * 60  // 25 mph city avg → minutes
        });
      }
    }
  }, [route, onRouteCalculated]);

  return (
    <div
      ref={mapContainerRef}
      className="w-full h-full rounded-2xl shadow-xl border-4 border-white overflow-hidden relative"
    />
  );
};

export default MapView;
