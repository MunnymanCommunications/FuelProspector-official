import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet-routing-machine';
import { GasStationLead } from '../types';

interface MapViewProps {
  leads: GasStationLead[];
  route: GasStationLead[];
  onSelectLead: (lead: GasStationLead) => void;
  onRouteCalculated?: (summary: { distance: number; time: number }) => void;
}

const MapView: React.FC<MapViewProps> = ({ leads, route, onSelectLead, onRouteCalculated }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const routingControlRef = useRef<any>(null);

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

  const createMarkerIcon = (color: string, label?: string) => {
    const html = `
      <div style="position: relative; width: 32px; height: 32px;">
        <svg viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,0.3));">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
        </svg>
        ${label ? `
          <div style="position: absolute; top: 4px; left: 50%; transform: translateX(-50%); color: white; font-size: 10px; font-weight: 800; pointer-events: none;">
            ${label}
          </div>
        ` : ''}
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

  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    if (leads.length > 0) {
      const group = L.featureGroup();
      leads.forEach(lead => {
        const color = lead.confidence === 'high' ? '#10b981' : lead.confidence === 'medium' ? '#f59e0b' : '#64748b';
        const routeIdx = route.findIndex(r => r.id === lead.id);
        const label = routeIdx !== -1 ? (routeIdx + 1).toString() : undefined;

        const marker = L.marker([lead.lat, lead.lng], { icon: createMarkerIcon(color, label) })
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

  useEffect(() => {
    if (!mapRef.current) return;

    if (routingControlRef.current) {
      mapRef.current.removeControl(routingControlRef.current);
      routingControlRef.current = null;
    }

    if (route.length > 1) {
      const waypoints = route.map(l => L.latLng(l.lat, l.lng));
      
      routingControlRef.current = L.Routing.control({
        waypoints,
        routeWhileDragging: false,
        addWaypoints: false,
        draggableWaypoints: false,
        fitSelectedRoutes: true,
        show: false,
        lineOptions: {
          styles: [{ color: '#6366f1', opacity: 0.8, weight: 6 }]
        },
        createMarker: () => null
      }).addTo(mapRef.current);

      routingControlRef.current.on('routesfound', (e: any) => {
        const routes = e.routes;
        const summary = routes[0].summary;
        if (onRouteCalculated) {
          onRouteCalculated({
            // Convert meters to miles
            distance: summary.totalDistance * 0.000621371, 
            time: summary.totalTime / 60
          });
        }
      });
    }
  }, [route, onRouteCalculated]);

  return <div ref={mapContainerRef} className="w-full h-full rounded-2xl shadow-xl border-4 border-white overflow-hidden relative" />;
};

export default MapView;
