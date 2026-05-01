
import { GoogleGenAI } from "@google/genai";
import { GasStationLead, GroundingLink, EnrichmentProgress } from "../types";

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

// PHASE 1: Discover sites and geocode them (no enrichment)
export const discoverLeads = async (location: string, userCoords?: { lat: number, lng: number }): Promise<{
  leads: GasStationLead[],
  groundingLinks: GroundingLink[]
}> => {
  console.log('[FuelProspector] Starting discoverLeads for location:', location);
  console.log('[FuelProspector] User coordinates:', userCoords);

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Set it as a build-time environment variable in Coolify and redeploy.');
  }

  const ai = new GoogleGenAI({ apiKey });

  // PHASE 1: Rapid Site Discovery
  console.log('[FuelProspector] Phase 1: Starting site discovery...');
  const discoveryPrompt = `
    Find every independent gas station and small local chain operating in or near "${location}".

    INSTRUCTIONS:
    1. Identify brands like "Stop & Save", "Quick-Stop", and other non-national entities.
    2. For every brand found, you MUST list the physical address of EVERY location they have in this area.
    3. Include "mom-and-pop" standalone stations.
    4. Exclude major national chains (Shell, Exxon, BP, etc.).

    OUTPUT FORMAT (REQUIRED):
    Return ONLY a raw JSON array. No prose, no markdown fences, no explanation.
    Each element must be an object with exactly these keys:
      "name"    (string, required)
      "address" (string, required)
      "brand"   (string, optional)

    Example: [{"name":"Stop & Save","address":"123 Main St, City, ST","brand":"Stop & Save"}]
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
    console.log('[FuelProspector] Phase 1 response received:', discoveryResponse.text?.substring(0, 200));
  } catch (error: any) {
    console.error('[FuelProspector] Phase 1 ERROR:', error.message);
    console.error('[FuelProspector] Phase 1 Full error:', error);
    throw new Error(`Phase 1 (Discovery) failed: ${error.message}`);
  }

  const discoveredSites = parseGroundedJson<Array<{ name: string; address: string; brand?: string }>>(
    discoveryResponse.text,
    []
  );
  console.log('[FuelProspector] Phase 1 discovered sites:', discoveredSites.length);
  if (discoveredSites.length === 0 && discoveryResponse.text) {
    console.warn('[FuelProspector] Phase 1 returned text but parsed to 0 sites. Raw:', discoveryResponse.text.substring(0, 500));
  }

  if (discoveredSites.length === 0) {
    console.log('[FuelProspector] No sites discovered, returning empty results');
    return { leads: [], groundingLinks: [] };
  }

  // Extract grounding links from discovery phase
  const groundingLinks: GroundingLink[] = [];
  discoveryResponse.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((chunk: any) => {
    if (chunk.web) groundingLinks.push({ uri: chunk.web.uri, title: chunk.web.title });
  });

  // PHASE 2: Geocoding (skip enrichment for now)
  console.log('[FuelProspector] Phase 2: Starting geocoding for', discoveredSites.length, 'sites...');
  const geocodePrompt = `
    Provide coordinates for these physical locations:
    ${discoveredSites.map((l: any) => `${l.name} at ${l.address}`).join('\n')}

    Format: [Name] | [Lat] | [Lng]
  `;

  let geoResponse;
  try {
    geoResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: geocodePrompt,
      config: {
        tools: [{ googleMaps: {} }],
        toolConfig: {
          retrievalConfig: {
            latLng: userCoords ? { latitude: userCoords.lat, longitude: userCoords.lng } : undefined
          }
        }
      }
    });
    console.log('[FuelProspector] Phase 2 geocoding response received:', geoResponse.text?.substring(0, 200));
  } catch (error: any) {
    console.error('[FuelProspector] Phase 2 ERROR:', error.message);
    console.error('[FuelProspector] Phase 2 Full error:', error);
    throw new Error(`Phase 2 (Geocoding) failed: ${error.message}`);
  }

  const geoText = geoResponse.text || "";
  const leads: GasStationLead[] = discoveredSites.map((site: any, index: number) => {
    const lines = geoText.split('\n');
    let lat = 0, lng = 0;

    for (const line of lines) {
      if (line.toLowerCase().includes(site.name.toLowerCase().substring(0, 10)) ||
          line.toLowerCase().includes(site.address.toLowerCase().substring(0, 10))) {
        const nums = line.match(/-?\d+\.\d+/g);
        if (nums && nums.length >= 2) {
          lat = parseFloat(nums[0]);
          lng = parseFloat(nums[1]);
          break;
        }
      }
    }

    return {
      id: `lead-${index}-${Date.now()}`,
      name: site.name,
      address: site.address,
      lat: lat || (userCoords?.lat || 0),
      lng: lng || (userCoords?.lng || 0),
      confidence: 'low' as const,
      sourceUrls: groundingLinks.map(l => l.uri),
      isEnriched: false
    };
  }).filter((l: GasStationLead) => l.lat !== 0 && !isNaN(l.lat));

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
