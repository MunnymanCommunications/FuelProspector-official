
import React from 'react';
import { GasStationLead } from '../types';

const LeadCard: React.FC<{
  lead: GasStationLead;
  onSelect: () => void;
  onExport: () => void;
  onEnrich?: () => void;
  onDelete?: () => void;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}> = ({ lead, onSelect, onExport, onEnrich, onDelete, isSelected, onToggleSelect }) => {
  const copyToClipboard = () => {
    const text = `Company: ${lead.name}\nLocation: ${lead.address}\nOwner: ${lead.ownerName || 'N/A'}\nPhone: ${lead.contactInfo || 'N/A'}\nEmail: ${lead.email || 'N/A'}\nWebsite: ${lead.website || 'N/A'}`;
    navigator.clipboard.writeText(text);
    alert('Lead data copied to clipboard!');
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDelete) return;
    if (window.confirm(`Remove "${lead.name}" from your list?`)) {
      onDelete();
    }
  };

  return (
    <div
      className={`bg-white p-4 rounded-xl border shadow-sm hover:shadow-md transition-all cursor-pointer group no-print ${
        isSelected ? 'border-red-400 ring-2 ring-red-200' : 'border-slate-200'
      }`}
      onClick={onSelect}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {onToggleSelect && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
              className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                isSelected
                  ? 'bg-red-600 border-red-600 text-white'
                  : 'border-slate-300 hover:border-red-400'
              }`}
              aria-label={isSelected ? 'Deselect' : 'Select'}
            >
              {isSelected && <span className="text-[10px] font-black leading-none">✓</span>}
            </button>
          )}
          <h3 className="font-bold text-slate-800 text-lg group-hover:text-red-600 transition-colors truncate">
            {lead.name}
          </h3>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {!lead.isEnriched && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black tracking-widest bg-amber-100 text-amber-700">
              NOT ENRICHED
            </span>
          )}
          {lead.isEnriched && (
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black tracking-widest ${
              lead.confidence === 'high' ? 'bg-green-100 text-green-700' :
              lead.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-100 text-slate-700'
            }`}>
              {lead.confidence.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2 text-sm text-slate-600">
        <div className="flex items-start gap-2">
          <div className="mt-1 text-red-500">📍</div>
          <p className="flex-1">{lead.address}</p>
        </div>

        {lead.isEnriched ? (
          <>
            <div className="flex items-center gap-2">
              <div className="text-red-500">👤</div>
              <p className="flex-1"><span className="font-medium">Owner:</span> {lead.ownerName || 'Unknown'}</p>
            </div>

            <div className="flex items-center gap-2">
              <div className="text-red-500">⛽</div>
              <p className="flex-1"><span className="font-medium">Scale:</span> {lead.numLocations || 'N/A'} {lead.numLocations ? 'location(s)' : ''}</p>
            </div>

            {lead.contactInfo && (
              <div className="flex items-center gap-2">
                <div className="text-red-500">📞</div>
                <a
                  href={`tel:${lead.contactInfo.replace(/\D/g, '')}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-red-600 hover:underline flex-1"
                >
                  {lead.contactInfo}
                </a>
              </div>
            )}

            {lead.email && (
              <div className="flex items-center gap-2">
                <div className="text-red-500">✉️</div>
                <a
                  href={`mailto:${lead.email}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-red-600 hover:underline flex-1 truncate"
                >
                  {lead.email}
                </a>
              </div>
            )}

            {lead.website && (
              <div className="flex items-center gap-2">
                <div className="text-red-500">🌐</div>
                <a
                  href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-red-600 hover:underline flex-1 truncate"
                >
                  View Website
                </a>
              </div>
            )}
          </>
        ) : (
          <div className="py-2 text-slate-400 text-xs italic">
            Click "Enrich" to find owner & contact details
          </div>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-slate-100 flex gap-2">
        {!lead.isEnriched && onEnrich && (
          <button
            onClick={(e) => { e.stopPropagation(); onEnrich(); }}
            disabled={lead.isEnriching}
            className="flex-1 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1 transition-colors"
          >
            {lead.isEnriching ? (
              <>
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Enriching...
              </>
            ) : (
              <>🔍 Enrich</>
            )}
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); copyToClipboard(); }}
          className="flex-1 bg-slate-50 hover:bg-slate-100 text-slate-700 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1 transition-colors"
        >
          📋 Copy
        </button>
        {onDelete && (
          <button
            onClick={handleDelete}
            title="Remove lead"
            aria-label="Remove lead"
            className="px-3 bg-red-50 hover:bg-red-100 text-red-600 py-2 rounded-lg text-xs font-bold flex items-center justify-center transition-colors"
          >
            🗑️
          </button>
        )}
      </div>
    </div>
  );
};

export default LeadCard;
