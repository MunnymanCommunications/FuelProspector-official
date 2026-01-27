
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
}

export interface GroundingLink {
  uri: string;
  title: string;
}

export interface ProspectingState {
  leads: GasStationLead[];
  isLoading: boolean;
  error: string | null;
  location: string;
  groundingLinks: GroundingLink[];
  route: GasStationLead[];
}
