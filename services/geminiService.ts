
import { GoogleGenAI } from "@google/genai";
import { GasStationLead, GroundingLink, EnrichmentProgress, DiscoveryProgress } from "../types";

// Grounded responses (googleSearch / googleMaps) cannot use responseMimeType:
// "application/json", so the model returns text. It often wraps JSON in
// ```json ... ``` fences. Strip them before parsing.
const parseGroundedJson = <T>(text: string | undefined, fallback: T): T => {
  if (!text) return fallback;
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) cleaned = fence[1].trim();
  // Last resort: find the first [ or { and parse from there.
  const firstBracket = cleaned.search(/[\[{]/);
  if (firstBracket > 0) cleaned = cleaned.slice(firstBracket);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
};

// Single-phase: discover sites AND get their coordinates in one grounded search call.
// A separate geocoding step was removed because the Maps tool fuzzy name-matching
// broke whenever multiple stations shared the same name (e.g. 10x "United Dairy Farmers").
export const discoverLeads = async (location: string, userCoords?: { lat: number, lng: number }): Promise<{
  leads: GasStationLead[],
  groundingLinks: GroundingLink[]
}> => {
  console.log('[FuelProspector] Starting discoverLeads for location:', location);

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Set it as a build-time environment variable in Coolify and redeploy.');
  }

  const ai = new GoogleGenAI({ apiKey });

  console.log('[FuelProspector] Discovering sites with coordinates...');
  const discoveryPrompt = `
    Find every independent gas station and small local chain operating in or near "${location}".

    INSTRUCTIONS:
    1. Identify brands like "Stop & Save", "Quick-Stop", and other non-national entities.
    2. For every brand found, list EVERY location in this area with its address and GPS coordinates.
    3. Include "mom-and-pop" standalone stations.
    4. Exclude major national chains (Shell, Exxon, BP, Chevron, Mobil, Marathon, Sunoco, Circle K, Speedway, Wawa, QuikTrip, Casey's, etc.).

    CRITICAL FIELD RULES:
    - "name": Business name ONLY as it appears on signage (e.g. "Wally's Corner Fuel"). NEVER a street address.
    - "address": Full street address only (e.g. "123 Main St, Columbus, OH 43201").
    - "lat": GPS latitude as a decimal number (e.g. 39.9612)
    - "lng": GPS longitude as a decimal number (e.g. -82.9988)

    OUTPUT FORMAT (REQUIRED):
    Return ONLY a raw JSON array. No prose, no markdown fences, no explanation.
    Required keys per element: "name", "address", "lat", "lng"
    Optional key: "brand"

    Example: [{"name":"Stop & Save","address":"123 Main St, Columbus, OH 43201","lat":39.961,"lng":-82.998,"brand":"Stop & Save"}]
  `;

  let discoveryResponse;
  try {
    discoveryResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: discoveryPrompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });
    console.log('[FuelProspector] Discovery response received:', discoveryResponse.text?.substring(0, 300));
  } catch (error: any) {
    console.error('[FuelProspector] Discovery ERROR:', error.message);
    throw new Error(`Discovery failed: ${error.message}`);
  }

  type RawSite = { name: string; address: string; lat?: number; lng?: number; brand?: string };
  const rawSites = parseGroundedJson<RawSite[]>(discoveryResponse.text, []);

  // Sanitize: detect entries where Gemini put an address string in the "name" field
  const addressPattern = /,\s*[A-Z]{2}\b/;
  const discoveredSites = rawSites.filter(s => s.name && s.address).map(s => {
    if (addressPattern.test(s.name) || /\b\d{5}\b/.test(s.name)) {
      console.warn(`[FuelProspector] Address-as-name corrected: "${s.name}"`);
      const fixedName = (s.brand && !addressPattern.test(s.brand)) ? s.brand : 'Independent Station';
      return { ...s, name: fixedName };
    }
    return s;
  });

  console.log('[FuelProspector] Discovered sites:', discoveredSites.length);
  if (discoveredSites.length === 0 && discoveryResponse.text) {
    console.warn('[FuelProspector] Parsed 0 sites. Raw:', discoveryResponse.text.substring(0, 500));
  }

  if (discoveredSites.length === 0) {
    return { leads: [], groundingLinks: [] };
  }

  const groundingLinks: GroundingLink[] = [];
  discoveryResponse.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((chunk: any) => {
    if (chunk.web) groundingLinks.push({ uri: chunk.web.uri, title: chunk.web.title });
  });

  const timestamp = Date.now();
  const leads: GasStationLead[] = discoveredSites
    .map((site, index) => ({
      id: `lead-${index}-${timestamp}`,
      name: site.name,
      address: site.address,
      lat: typeof site.lat === 'number' ? site.lat : 0,
      lng: typeof site.lng === 'number' ? site.lng : 0,
      confidence: 'low' as const,
      sourceUrls: groundingLinks.map(l => l.uri),
      isEnriched: false
    }))
    .filter(l => l.lat !== 0 && l.lng !== 0 && !isNaN(l.lat) && !isNaN(l.lng));

  console.log('[FuelProspector] Discovery complete:', leads.length, 'leads with coordinates');
  return { leads, groundingLinks };
};

// Enrich a single lead with owner/contact info
export const enrichSingleLead = async (lead: GasStationLead): Promise<GasStationLead> => {
  console.log('[FuelProspector] Enriching single lead:', lead.name);

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const ai = new GoogleGenAI({ apiKey });

  const enrichmentPrompt = `
    Find detailed business information for this gas station:
    Name: ${lead.name}
    Address: ${lead.address}

    Search for and provide:
    - Owner/Principal Name (the actual person who owns or manages this location)
    - Number of locations they operate (only if verified, do NOT guess)
    - Business Phone Number
    - Business Email Address
    - Website URL

    IMPORTANT:
    - If owner info cannot be found, use "Independent Owner"
    - If location count is unknown, omit it
    - Set confidence to "high" if owner verified from official sources, "medium" if from reviews/listings, "low" if uncertain

    OUTPUT FORMAT (REQUIRED):
    Return ONLY a single raw JSON object. No prose, no markdown fences, no explanation.
    Keys: ownerName (string), numLocations (number), contactInfo (string),
          email (string), website (string), confidence ("high"|"medium"|"low").
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: enrichmentPrompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const enrichedData = parseGroundedJson<any>(response.text, {});
    console.log('[FuelProspector] Single lead enriched:', lead.name);

    return {
      ...lead,
      ownerName: enrichedData.ownerName || 'Independent Owner',
      numLocations: enrichedData.numLocations || 0,
      contactInfo: enrichedData.contactInfo || undefined,
      email: enrichedData.email || undefined,
      website: enrichedData.website || undefined,
      confidence: enrichedData.confidence || 'medium',
      isEnriched: true,
      isEnriching: false
    };
  } catch (error: any) {
    console.error('[FuelProspector] Single lead enrichment ERROR:', error.message);
    return {
      ...lead,
      ownerName: 'Independent Owner',
      numLocations: 0,
      confidence: 'low',
      isEnriched: true,
      isEnriching: false
    };
  }
};

// Bulk enrich multiple leads with progress callback
export const enrichLeads = async (
  leads: GasStationLead[],
  location: string,
  onProgress?: (progress: EnrichmentProgress) => void,
  onLeadEnriched?: (lead: GasStationLead) => void
): Promise<{ leads: GasStationLead[], groundingLinks: GroundingLink[] }> => {
  console.log('[FuelProspector] Starting bulk enrichment for', leads.length, 'leads...');

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const enrichedLeads: GasStationLead[] = [];
  const allGroundingLinks: GroundingLink[] = [];

  // Process in batches of 5 to balance speed and reliability
  const batchSize = 5;
  const totalLeads = leads.length;

  for (let i = 0; i < leads.length; i += batchSize) {
    const batch = leads.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(leads.length / batchSize);

    console.log(`[FuelProspector] Processing batch ${batchNumber}/${totalBatches}`);

    // Update progress
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: totalLeads,
        currentName: batch[0]?.name
      });
    }

    const enrichmentPrompt = `
      LEAD ENRICHMENT for "${location}":

      Sites to enrich:
      ${batch.map((l, idx) => `${idx + 1}. ${l.name} at ${l.address}`).join('\n')}

      TASK:
      For EACH site listed above, search and find:
      - Owner/Principal Name (if available)
      - Number of locations they operate (only if verified, do NOT guess)
      - Contact Phone
      - Business Email
      - Website

      IMPORTANT:
      - Return ALL ${batch.length} sites in your response
      - If owner info cannot be found, use "Independent Owner" as the ownerName
      - If location count is unknown, omit numLocations or set to 0
      - Set confidence to "high" if owner verified, "medium" if partially verified, "low" if estimated

      OUTPUT FORMAT (REQUIRED):
      Return ONLY a raw JSON array of ${batch.length} objects. No prose, no markdown fences.
      Each object keys: name, address, ownerName, numLocations, contactInfo,
      email, website, confidence ("high"|"medium"|"low").
    `;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: enrichmentPrompt,
        config: {
          tools: [{ googleSearch: {} }]
        }
      });

      // Extract grounding links
      response.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((chunk: any) => {
        if (chunk.web) allGroundingLinks.push({ uri: chunk.web.uri, title: chunk.web.title });
      });

      const enrichedBatch = parseGroundedJson<any[]>(response.text, []);

      // Match enriched data back to original leads
      for (const originalLead of batch) {
        const enrichedData = enrichedBatch.find((e: any) =>
          e.name?.toLowerCase().includes(originalLead.name.toLowerCase().substring(0, 10)) ||
          e.address?.toLowerCase().includes(originalLead.address.toLowerCase().substring(0, 10)) ||
          originalLead.name.toLowerCase().includes(e.name?.toLowerCase().substring(0, 10))
        ) || {};

        const enrichedLead: GasStationLead = {
          ...originalLead,
          ownerName: enrichedData.ownerName || 'Independent Owner',
          numLocations: enrichedData.numLocations || 0,
          contactInfo: enrichedData.contactInfo || undefined,
          email: enrichedData.email || undefined,
          website: enrichedData.website || undefined,
          confidence: enrichedData.confidence || 'medium',
          isEnriched: true,
          isEnriching: false
        };

        enrichedLeads.push(enrichedLead);

        // Notify about each enriched lead for real-time UI updates
        if (onLeadEnriched) {
          onLeadEnriched(enrichedLead);
        }
      }

      // Update progress after batch
      if (onProgress) {
        onProgress({
          current: Math.min(i + batchSize, totalLeads),
          total: totalLeads,
          currentName: batch[batch.length - 1]?.name
        });
      }

    } catch (error: any) {
      console.error(`[FuelProspector] Batch ${batchNumber} enrichment ERROR:`, error.message);
      // On error, add leads with default values
      for (const originalLead of batch) {
        const defaultLead: GasStationLead = {
          ...originalLead,
          ownerName: 'Independent Owner',
          numLocations: 0,
          confidence: 'low',
          isEnriched: true,
          isEnriching: false
        };
        enrichedLeads.push(defaultLead);
        if (onLeadEnriched) {
          onLeadEnriched(defaultLead);
        }
      }
    }
  }

  console.log('[FuelProspector] Bulk enrichment complete:', enrichedLeads.length, 'leads enriched');
  return { leads: enrichedLeads, groundingLinks: allGroundingLinks };
};

// Legacy function for backwards compatibility - combines discover + enrich
export const findLeads = async (location: string, userCoords?: { lat: number, lng: number }): Promise<{
  leads: GasStationLead[],
  groundingLinks: GroundingLink[]
}> => {
  const { leads: discoveredLeads, groundingLinks } = await discoverLeads(location, userCoords);
  const { leads: enrichedLeads, groundingLinks: enrichGroundingLinks } = await enrichLeads(discoveredLeads, location);
  return {
    leads: enrichedLeads,
    groundingLinks: [...groundingLinks, ...enrichGroundingLinks]
  };
};

// ─── DEEP SCAN: zip-code-segmented discovery ─────────────────────────────────

// Fetch all zip/postal codes for a given city using grounded search
export const getZipCodesForCity = async (location: string): Promise<string[]> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `List every postal/zip code that falls within "${location}" city limits and its immediate metro area.

OUTPUT FORMAT (REQUIRED):
Return ONLY a raw JSON array of postal code strings. No prose, no markdown fences.
Example: ["43201","43202","43203","43204"]`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] }
    });
    const codes = parseGroundedJson<string[]>(response.text, []);
    const valid = codes.filter(z => typeof z === 'string' && z.trim().length > 0).map(z => z.trim());
    console.log(`[FuelProspector] Deep scan: found ${valid.length} zip/postal codes for ${location}`);
    return valid;
  } catch (error: any) {
    console.error('[FuelProspector] Zip fetch ERROR:', error.message);
    return [];
  }
};

type RawSite = { name: string; address: string; lat?: number; lng?: number; brand?: string };

// Run a targeted discovery search for one zip code, including GPS coordinates in the response
const discoverSitesForZip = async (
  ai: GoogleGenAI,
  zip: string,
  cityName: string
): Promise<{ sites: RawSite[], groundingLinks: GroundingLink[] }> => {
  const prompt = `
    Find every independent gas station and small local chain physically located in zip code ${zip} (${cityName}).

    INSTRUCTIONS:
    1. Include local/regional brands, small chains, and standalone "mom-and-pop" stations.
    2. List EVERY location within or immediately adjacent to zip code ${zip} with GPS coordinates.
    3. Exclude major national chains (Shell, Exxon, BP, Chevron, Mobil, Marathon, Sunoco, Circle K, Speedway, Wawa, QuikTrip, Casey's, etc.).

    CRITICAL FIELD RULES:
    - "name": Business name ONLY (e.g. "Wally's Gas"). NEVER a street address.
    - "address": Full street address (e.g. "123 Main St, Columbus, OH ${zip}").
    - "lat": GPS latitude as decimal (e.g. 39.9612)
    - "lng": GPS longitude as decimal (e.g. -82.9988)

    OUTPUT FORMAT (REQUIRED):
    Return ONLY a raw JSON array. No prose, no markdown fences.
    Each element: {"name":"...","address":"...","lat":0.0,"lng":0.0,"brand":"..."}
    Example: [{"name":"Stop & Save","address":"123 Main St, Columbus, OH ${zip}","lat":39.961,"lng":-82.998,"brand":"Stop & Save"}]
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] }
    });

    const sites = parseGroundedJson<RawSite[]>(response.text, []);

    const groundingLinks: GroundingLink[] = [];
    response.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((chunk: any) => {
      if (chunk.web) groundingLinks.push({ uri: chunk.web.uri, title: chunk.web.title });
    });

    console.log(`[FuelProspector] Zip ${zip}: found ${sites.length} sites`);
    return { sites, groundingLinks };
  } catch (error: any) {
    console.error(`[FuelProspector] Zip ${zip} ERROR:`, error.message);
    return { sites: [], groundingLinks: [] };
  }
};

// Remove duplicate stations by normalised name + address prefix
const deduplicateSites = (sites: RawSite[]): RawSite[] => {
  const seen = new Set<string>();
  return sites.filter(site => {
    const key = `${site.name.toLowerCase().replace(/\s+/g, '').substring(0, 15)}|${site.address.toLowerCase().replace(/\s+/g, '').substring(0, 25)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Deep scan: fetch zip codes → parallel per-zip discovery → dedup → geocode
export const discoverLeadsEnhanced = async (
  location: string,
  userCoords?: { lat: number; lng: number },
  onProgress?: (progress: DiscoveryProgress) => void
): Promise<{ leads: GasStationLead[], groundingLinks: GroundingLink[] }> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const ai = new GoogleGenAI({ apiKey });
  const allGroundingLinks: GroundingLink[] = [];

  // Phase 0: fetch zip codes
  onProgress?.({ phase: 'fetching-zips', current: 0, total: 0 });
  const zipCodes = await getZipCodesForCity(location);

  if (zipCodes.length < 3) {
    console.log('[FuelProspector] Deep scan: too few zip codes returned, falling back to standard discovery');
    return discoverLeads(location, userCoords);
  }

  // Phase 1: scan each zip code, 5 concurrent with a 1s gap between batches
  // to stay within Gemini rate limits on both free and paid tiers
  const allRawSites: Array<{ name: string; address: string; brand?: string }> = [];
  const concurrency = 5;

  for (let i = 0; i < zipCodes.length; i += concurrency) {
    const batch = zipCodes.slice(i, i + concurrency);
    onProgress?.({ phase: 'scanning', current: i, total: zipCodes.length, currentZip: batch[0] });

    const batchResults = await Promise.all(
      batch.map(zip => discoverSitesForZip(ai, zip, location))
    );

    for (const result of batchResults) {
      allRawSites.push(...result.sites);
      allGroundingLinks.push(...result.groundingLinks);
    }

    if (i + concurrency < zipCodes.length) {
      await new Promise(res => setTimeout(res, 1000));
    }
  }

  onProgress?.({ phase: 'scanning', current: zipCodes.length, total: zipCodes.length });

  // Deduplicate across all zip results
  const uniqueSites = deduplicateSites(allRawSites);
  console.log(`[FuelProspector] Deep scan: ${allRawSites.length} raw → ${uniqueSites.length} unique sites`);

  if (uniqueSites.length === 0) {
    console.log('[FuelProspector] Deep scan found no sites, falling back to standard discovery');
    return discoverLeads(location, userCoords);
  }

  // Coordinates were returned in the per-zip discovery responses — no separate geocoding needed
  const timestamp = Date.now();
  const sourceUris = allGroundingLinks.map(l => l.uri);
  const leads: GasStationLead[] = uniqueSites
    .map((site, idx) => ({
      id: `lead-deep-${idx}-${timestamp}`,
      name: site.name,
      address: site.address,
      lat: typeof site.lat === 'number' ? site.lat : 0,
      lng: typeof site.lng === 'number' ? site.lng : 0,
      confidence: 'low' as const,
      sourceUrls: sourceUris,
      isEnriched: false
    }))
    .filter(l => l.lat !== 0 && l.lng !== 0 && !isNaN(l.lat) && !isNaN(l.lng));

  console.log(`[FuelProspector] Deep scan complete: ${leads.length} leads with coordinates`);
  return { leads, groundingLinks: allGroundingLinks };
};

// ─────────────────────────────────────────────────────────────────────────────

export const optimizeRouteOrder = async (
  leads: GasStationLead[],
  startLocation: string,
  userCoords?: { lat: number, lng: number }
): Promise<string[]> => {
  console.log('[FuelProspector] Starting route optimization for', leads.length, 'leads');

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error('[FuelProspector] Route optimization ERROR: API key missing');
    return leads.map(l => l.id);
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
    TASK: Sequence these gas station leads to create the SHORTEST possible driving distance.
    START POINT: ${userCoords ? `Coordinates (${userCoords.lat}, ${userCoords.lng})` : startLocation}

    LEADS TO SEQUENCE (numbered 1 through ${leads.length}):
    ${leads.map((l, i) => `${i + 1}. ${l.name} | ${l.address} | LatLng: ${l.lat},${l.lng}`).join('\n')}

    INSTRUCTIONS:
    1. Calculate the most logical "next-nearest-neighbor" route from the start point.
    2. Minimize backtracking.
    3. Return ONLY a comma-separated list of the position numbers in optimized order.
       Example for 5 leads: 3,1,4,2,5
       Do NOT return names, addresses, or any other text. Just the numbers.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        temperature: 0.1
      }
    });

    const text = response.text || "";
    console.log('[FuelProspector] Route optimization response:', text.substring(0, 200));

    // Extract all integers from the response, then map 1-based positions to lead IDs.
    const positions = (text.match(/\d+/g) || [])
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= leads.length);

    // Deduplicate while preserving order.
    const seen = new Set<number>();
    const orderedIds: string[] = [];
    for (const pos of positions) {
      if (!seen.has(pos)) {
        seen.add(pos);
        orderedIds.push(leads[pos - 1].id);
      }
    }

    if (orderedIds.length === 0) {
      console.log('[FuelProspector] Route optimization: No valid positions found, using default order');
      return leads.map(l => l.id);
    }

    // Append any leads the model omitted, in original order, so nothing is dropped.
    for (const lead of leads) {
      if (!orderedIds.includes(lead.id)) orderedIds.push(lead.id);
    }

    console.log('[FuelProspector] Route optimization complete:', orderedIds.length, 'leads ordered');
    return orderedIds;
  } catch (error: any) {
    console.error('[FuelProspector] Route optimization ERROR:', error.message);
    console.error('[FuelProspector] Full error:', error);
    return leads.map(l => l.id);
  }
};
