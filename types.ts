
export interface GasStationLead {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  ownerName?: string;
  numLocations?: number;
  contactInfo?: string;
  email?: string;
  website?: string;
  confidence: 'high' | 'medium' | 'low';
  sourceUrls: string[];
  isEnriched: boolean;
  isEnriching?: boolean;
}

export interface GroundingLink {
  uri: string;
  title: string;
}

export interface EnrichmentProgress {
  current: number;
  total: number;
  currentName?: string;
}

export interface ProspectingState {
  leads: GasStationLead[];
  isLoading: boolean;
  error: string | null;
  location: string;
  groundingLinks: GroundingLink[];
  route: GasStationLead[];
  isEnriching: boolean;
  enrichmentProgress: EnrichmentProgress | null;
}
