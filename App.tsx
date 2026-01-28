
import React, { useState, useCallback, useEffect } from 'react';
import { ProspectingState, GasStationLead } from './types';
import { findLeads, optimizeRouteOrder } from './services/geminiService';
import MapView from './components/MapView';
import LeadCard from './components/LeadCard';

const App: React.FC = () => {
  const [isAuthorized, setIsAuthorized] = useState<boolean>(() => {
    return sessionStorage.getItem('fprospector_auth') === 'true';
  });
  const [pin, setPin] = useState<string>('');
  const [pinError, setPinError] = useState<boolean>(false);

  const [state, setState] = useState<ProspectingState>({
    leads: [],
    isLoading: false,
    error: null,
    location: '',
    groundingLinks: [],
    route: []
  });
  const [userCoords, setUserCoords] = useState<{lat: number, lng: number} | undefined>();
  const [routeStats, setRouteStats] = useState<{distance: number; time: number} | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [showPrintPreview, setShowPrintPreview] = useState(false);

  const requestUserLocation = useCallback((): Promise<{lat: number, lng: number} | undefined> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(undefined);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserCoords(coords);
          resolve(coords);
        },
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: 5000 }
      );
    });
  }, []);

  useEffect(() => {
    if (isAuthorized) {
      requestUserLocation();
    }
  }, [isAuthorized, requestUserLocation]);

  const handlePinSubmit = (digit?: string) => {
    const newPin = digit !== undefined ? pin + digit : pin;
    
    if (newPin.length === 4) {
      if (newPin === '2580') {
        setIsAuthorized(true);
        sessionStorage.setItem('fprospector_auth', 'true');
      } else {
        setPinError(true);
        setTimeout(() => {
          setPin('');
          setPinError(false);
        }, 600);
      }
    } else {
      setPin(newPin);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state.location) return;

    setState(prev => ({ ...prev, isLoading: true, error: null, leads: [], route: [] }));
    setRouteStats(null);
    setLoadingStep('Phase 1: Discovering independent sites...');

    try {
      setTimeout(() => setLoadingStep('Phase 2: Verifying owners & harvesting contacts...'), 3000);
      setTimeout(() => setLoadingStep('Phase 3: Pinpointing map locations...'), 7000);

      const currentPos = await requestUserLocation();
      const { leads, groundingLinks } = await findLeads(state.location, currentPos);
      
      setState(prev => ({
        ...prev,
        leads,
        groundingLinks,
        isLoading: false
      }));
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err.message || 'The search encountered an error. Please try again.'
      }));
    }
  };

  const handleGenerateOptimizedRoute = useCallback(async () => {
    if (state.leads.length === 0) return;
    setIsOptimizing(true);
    try {
      const currentPos = await requestUserLocation();
      const orderedIds = await optimizeRouteOrder(state.leads, state.location, currentPos);
      
      const optimizedRoute = orderedIds
        .map(id => state.leads.find(l => l.id === id))
        .filter((l): l is GasStationLead => !!l);
      
      const remaining = state.leads.filter(l => !orderedIds.includes(l.id));
      
      setState(prev => ({ 
        ...prev, 
        route: [...optimizedRoute, ...remaining] 
      }));
    } catch (err) {
      console.error("Route optimization error:", err);
      setState(prev => ({ ...prev, route: prev.leads }));
    } finally {
      setIsOptimizing(false);
    }
  }, [state.leads, state.location, requestUserLocation]);

  const openInGoogleMaps = () => {
    if (state.route.length === 0) return;
    const origin = userCoords ? `${userCoords.lat},${userCoords.lng}` : encodeURIComponent(state.route[0].address);
    const destination = encodeURIComponent(state.route[state.route.length - 1].address);
    const waypointsArr = userCoords ? state.route.slice(0, state.route.length - 1) : state.route.slice(1, state.route.length - 1);
    const waypoints = waypointsArr.map(l => encodeURIComponent(l.address)).join('|');
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints ? `&waypoints=${waypoints}` : ''}&travelmode=driving`;
    window.open(url, '_blank');
  };

  const handleExportAll = () => {
    const csvContent = "data:text/csv;charset=utf-8," 
      + ["Company,Address,Owner,Scale,Phone,Email,Website"].concat(
          state.leads.map(l => `"${l.name}","${l.address}","${l.ownerName}","${l.numLocations}","${l.contactInfo}","${l.email}","${l.website}"`)
        ).join("\n");
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `prospects.csv`);
    link.click();
  };

  const currentItinerary = state.route.length > 0 ? state.route : state.leads;

  if (!isAuthorized) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-900 overflow-hidden font-sans">
        <div className={`w-full max-w-md p-8 flex flex-col items-center transition-all duration-300 ${pinError ? 'translate-x-2 animate-shake' : ''}`}>
          <div className="bg-indigo-600 w-16 h-16 rounded-2xl flex items-center justify-center text-white font-black text-3xl shadow-2xl mb-8">F</div>
          <h1 className="text-white text-2xl font-bold mb-2">FuelProspector AI</h1>
          <p className="text-slate-400 text-sm mb-12">Enter 4-digit access pin</p>
          
          <div className="flex gap-4 mb-12">
            {[0, 1, 2, 3].map((i) => (
              <div 
                key={i} 
                className={`w-4 h-4 rounded-full border-2 transition-all duration-200 ${
                  pin.length > i ? 'bg-indigo-500 border-indigo-500 scale-125' : 'border-slate-700'
                }`} 
              />
            ))}
          </div>

          <div className="grid grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
              <button 
                key={num}
                onClick={() => handlePinSubmit(num.toString())}
                className="w-16 h-16 rounded-full border border-slate-800 text-white text-xl font-bold flex items-center justify-center hover:bg-slate-800 active:scale-90 transition-all"
              >
                {num}
              </button>
            ))}
            <div />
            <button 
              onClick={() => handlePinSubmit('0')}
              className="w-16 h-16 rounded-full border border-slate-800 text-white text-xl font-bold flex items-center justify-center hover:bg-slate-800 active:scale-90 transition-all"
            >
              0
            </button>
            <button 
              onClick={() => setPin(pin.slice(0, -1))}
              className="w-16 h-16 rounded-full text-slate-500 text-sm font-bold flex items-center justify-center hover:text-white transition-colors"
            >
              DEL
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-screen font-sans text-slate-900 ${showPrintPreview ? 'bg-slate-200' : 'bg-[#F1F5F9]'}`}>
      {!showPrintPreview && (
        <>
          <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between sticky top-0 z-30 shadow-sm no-print">
            <div className="flex items-center gap-3">
              <div className="bg-indigo-600 w-10 h-10 rounded-xl flex items-center justify-center text-white font-black text-xl shadow-lg shadow-indigo-200">F</div>
              <div className="hidden sm:block">
                <h1 className="text-lg font-bold text-slate-800 leading-none tracking-tight">FuelProspector</h1>
                <p className="text-[10px] text-indigo-500 mt-0.5 font-bold uppercase tracking-widest leading-none">Sales Discovery Engine</p>
              </div>
            </div>
            <form onSubmit={handleSearch} className="flex-1 max-w-2xl mx-6 flex gap-2">
              <input
                type="text"
                placeholder="Enter City, State or Zip Code..."
                className="w-full pl-4 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
                value={state.location}
                onChange={(e) => setState(prev => ({ ...prev, location: e.target.value }))}
              />
              <button type="submit" disabled={state.isLoading} className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-xl font-bold transition-all whitespace-nowrap">
                {state.isLoading ? 'Finding...' : 'Find Leads'}
              </button>
            </form>
            <div className="flex gap-2">
              <button 
                onClick={() => setShowPrintPreview(true)} 
                disabled={state.leads.length === 0} 
                className="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border border-slate-100 rounded-xl transition-all shadow-sm active:scale-90" 
                title="Generate Print Report"
              >
                🖨️
              </button>
              <button 
                onClick={handleExportAll} 
                disabled={state.leads.length === 0} 
                className="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border border-slate-100 rounded-xl transition-all shadow-sm active:scale-90" 
                title="Export CSV"
              >
                📤
              </button>
            </div>
          </header>

          <main className="flex-1 flex overflow-hidden">
            <div className="w-96 border-r border-slate-200 bg-white flex flex-col shadow-xl z-20">
              <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <h2 className="font-black text-slate-800">Results ({state.leads.length})</h2>
                {state.leads.length > 1 && (
                  <button onClick={handleGenerateOptimizedRoute} disabled={isOptimizing} className="text-xs font-black text-white bg-indigo-500 hover:bg-indigo-600 px-3 py-1.5 rounded-lg transition-all">
                    {isOptimizing ? '🤖 Routing...' : '✨ Smart Route'}
                  </button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {state.isLoading ? (
                   <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                      <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4" />
                      <p className="text-xs font-medium">{loadingStep}</p>
                   </div>
                ) : state.leads.length === 0 ? (
                  <div className="text-center py-20 text-slate-300 px-6">
                    <p className="text-xs font-bold uppercase tracking-widest mb-2">Search to begin</p>
                    <p className="text-[10px]">Independent owners with small portfolios await.</p>
                  </div>
                ) : (
                  state.leads.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} onSelect={() => {}} onExport={() => {}} />
                  ))
                )}
              </div>
            </div>

            <div className="flex-1 relative bg-[#E2E8F0]">
              <MapView leads={state.leads} route={state.route} onSelectLead={() => {}} onRouteCalculated={setRouteStats} />
              {routeStats && (
                <div className="absolute bottom-8 left-8 z-20 bg-white p-6 rounded-2xl shadow-2xl border border-indigo-50 min-w-[300px]">
                  <div className="flex justify-between mb-4">
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase">Distance</p>
                      <p className="text-lg font-black">{routeStats.distance.toFixed(1)} mi</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-slate-400 uppercase">Est. Drive</p>
                      <p className="text-lg font-black">{Math.round(routeStats.time)} min</p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button onClick={openInGoogleMaps} className="w-full bg-green-600 text-white py-2.5 rounded-xl font-bold text-sm">📱 Send to Phone</button>
                    <button onClick={() => setShowPrintPreview(true)} className="w-full bg-slate-900 text-white py-2.5 rounded-xl font-bold text-sm">📄 Full Report Preview</button>
                  </div>
                </div>
              )}
            </div>
          </main>
        </>
      )}

      {showPrintPreview && (
        <div className="fixed inset-0 z-[100] bg-slate-100 overflow-y-auto print:bg-white">
          <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex justify-between items-center z-50 shadow-md no-print">
            <button
              onClick={() => setShowPrintPreview(false)}
              className="px-4 py-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-700 font-bold text-sm"
            >
              ← Back to App
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => window.print()}
                className="bg-indigo-600 text-white px-10 py-3 rounded-xl font-black text-sm shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95"
              >
                Save as PDF or Print
              </button>
            </div>
          </div>

          <div className="max-w-[8.5in] mx-auto my-8 bg-white shadow-2xl p-[0.7in] min-h-[11in] rounded-sm print:shadow-none print:m-0 print:p-0 print:w-full overflow-visible" id="report-content">
             <header className="flex justify-between items-end border-b-4 border-slate-900 pb-6 mb-10">
              <div>
                <h1 className="text-4xl font-black text-indigo-700 tracking-tighter leading-none">Sales Itinerary</h1>
                <p className="text-slate-500 font-bold uppercase tracking-widest mt-2 text-[10px]">
                  Region: {state.location} - Generated {new Date().toLocaleDateString()}
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-black text-slate-900">{currentItinerary.length} Target Points</p>
                {routeStats && <p className="text-xs font-bold text-slate-500">{routeStats.distance.toFixed(1)} Total Driving Miles</p>}
              </div>
            </header>

            <div className="mb-10 h-[4in] border-2 border-slate-200 rounded-2xl overflow-hidden relative print:h-[3.5in]">
              <MapView leads={state.leads} route={state.route} onSelectLead={() => {}} />
            </div>

            <div className="space-y-8">
              <h2 className="text-xl font-black uppercase tracking-tight text-slate-900 border-b-2 border-slate-900 pb-1">Site Sequence</h2>

              {currentItinerary.map((lead, idx) => (
                <div key={lead.id} className="flex gap-6 pb-6 border-b border-slate-100 last:border-0 break-inside-avoid">
                  <div className="w-10 h-10 bg-slate-900 text-white rounded-full flex items-center justify-center text-lg font-black flex-shrink-0">
                    {idx + 1}
                  </div>
                  <div className="flex-1 grid grid-cols-2 gap-x-8">
                    <div className="col-span-2 mb-2">
                      <h3 className="text-lg font-black text-slate-900 leading-tight">{lead.name}</h3>
                      <p className="text-xs text-indigo-600 font-bold">{lead.address}</p>
                    </div>
                    <div className="text-xs leading-relaxed">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Owner Profile</p>
                      <p className="font-bold text-slate-700">{lead.ownerName || 'Independent'}</p>
                      <p className="text-slate-500">Portfolio: {lead.numLocations} units</p>
                    </div>
                    <div className="text-xs leading-relaxed">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Lead Contact</p>
                      <p className="font-bold text-slate-800">{lead.contactInfo || 'Not found'}</p>
                      <p className="text-slate-500 truncate">{lead.email || 'N/A'}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <footer className="mt-20 pt-8 border-t border-slate-200 flex justify-between items-center text-slate-300 text-[8px] font-black uppercase tracking-widest">
              <span>FuelProspector.ai Internal Report</span>
              <span>Proprietary Discovery Engine</span>
            </footer>
          </div>

          <div className="max-w-[8.5in] mx-auto mb-20 text-center text-slate-400 text-[10px] no-print">
            <p>Tip: To save as a file, change Destination to <strong>Save as PDF</strong> in your browser's print window.</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
