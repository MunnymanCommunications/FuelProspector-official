
import { GoogleGenAI, Type } from "@google/genai";
import { GasStationLead, GroundingLink } from "../types";

export const findLeads = async (location: string, userCoords?: { lat: number, lng: number }): Promise<{
  leads: GasStationLead[],
  groundingLinks: GroundingLink[]
}> => {
  console.log('[FuelProspector] Starting findLeads for location:', location);
  console.log('[FuelProspector] User coordinates:', userCoords);

  const apiKey = process.env.API_KEY;
  console.log('[FuelProspector] API Key configured:', apiKey ? `Yes (${apiKey.substring(0, 8)}...)` : 'NO - MISSING!');

  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured. Please add it to your .env file.');
    console.error('[FuelProspector] ERROR:', error.message);
    throw error;
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

    Return a JSON array of objects with 'name', 'address', and 'brand'.
  `;

  let discoveryResponse;
  try {
    discoveryResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: discoveryPrompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              address: { type: Type.STRING },
              brand: { type: Type.STRING }
            },
            required: ['name', 'address']
          }
        }
      }
    });
    console.log('[FuelProspector] Phase 1 response received:', discoveryResponse.text?.substring(0, 200));
  } catch (error: any) {
    console.error('[FuelProspector] Phase 1 ERROR:', error.message);
    console.error('[FuelProspector] Phase 1 Full error:', error);
    throw new Error(`Phase 1 (Discovery) failed: ${error.message}`);
  }

  let discoveredSites;
  try {
    discoveredSites = JSON.parse(discoveryResponse.text || "[]");
    console.log('[FuelProspector] Phase 1 discovered sites:', discoveredSites.length);
  } catch (parseError: any) {
    console.error('[FuelProspector] Phase 1 JSON parse error:', parseError.message);
    console.error('[FuelProspector] Raw response was:', discoveryResponse.text);
    throw new Error(`Phase 1 JSON parse failed: ${parseError.message}`);
  }

  if (discoveredSites.length === 0) {
    console.log('[FuelProspector] No sites discovered, returning empty results');
    return { leads: [], groundingLinks: [] };
  }

  // PHASE 2: Rapid Enrichment (include all sites, enrich where possible)
  console.log('[FuelProspector] Phase 2: Starting enrichment for', discoveredSites.length, 'sites...');
  const enrichmentPrompt = `
    LEAD ENRICHMENT for "${location}":

    Sites to enrich: ${JSON.stringify(discoveredSites.slice(0, 50))}

    TASK:
    For EACH site in the list above, try to find:
    - Owner/Principal Name (if available)
    - Number of locations they operate (only if verified, do NOT guess)
    - Contact Phone
    - Business Email
    - Website

    IMPORTANT: Include ALL sites from the input list in your response.
    - If owner info cannot be found, use "Independent Owner" as the ownerName
    - If location count is unknown, omit numLocations or set to 0
    - Set confidence to "high" if owner verified, "medium" if partially verified, "low" if estimated

    Return ALL sites as a JSON array, even if contact details are incomplete.
  `;

  let enrichmentResponse;
  try {
    enrichmentResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: enrichmentPrompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              address: { type: Type.STRING },
              ownerName: { type: Type.STRING },
              numLocations: { type: Type.NUMBER },
              contactInfo: { type: Type.STRING },
              email: { type: Type.STRING },
              website: { type: Type.STRING },
              confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] }
            },
            required: ['name', 'address']
          }
        }
      }
    });
    console.log('[FuelProspector] Phase 2 response received:', enrichmentResponse.text?.substring(0, 200));
  } catch (error: any) {
    console.error('[FuelProspector] Phase 2 ERROR:', error.message);
    console.error('[FuelProspector] Phase 2 Full error:', error);
    throw new Error(`Phase 2 (Enrichment) failed: ${error.message}`);
  }

  let enrichedLeads;
  try {
    enrichedLeads = JSON.parse(enrichmentResponse.text || "[]");
    console.log('[FuelProspector] Phase 2 enriched leads:', enrichedLeads.length);
  } catch (parseError: any) {
    console.error('[FuelProspector] Phase 2 JSON parse error:', parseError.message);
    console.error('[FuelProspector] Raw response was:', enrichmentResponse.text);
    throw new Error(`Phase 2 JSON parse failed: ${parseError.message}`);
  }

  const groundingLinks: GroundingLink[] = [];
  enrichmentResponse.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((chunk: any) => {
    if (chunk.web) groundingLinks.push({ uri: chunk.web.uri, title: chunk.web.title });
  });
  console.log('[FuelProspector] Grounding links found:', groundingLinks.length);

  // PHASE 3: Precise Geocoding
  console.log('[FuelProspector] Phase 3: Starting geocoding for', enrichedLeads.length, 'leads...');
  const geocodePrompt = `
    Provide coordinates for these physical locations:
    ${enrichedLeads.map((l: any) => `${l.name} at ${l.address}`).join('\n')}

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
    console.log('[FuelProspector] Phase 3 response received:', geoResponse.text?.substring(0, 200));
  } catch (error: any) {
    console.error('[FuelProspector] Phase 3 ERROR:', error.message);
    console.error('[FuelProspector] Phase 3 Full error:', error);
    throw new Error(`Phase 3 (Geocoding) failed: ${error.message}`);
  }

  const geoText = geoResponse.text || "";
  const finalLeads: GasStationLead[] = enrichedLeads.map((lead: any, index: number) => {
    const lines = geoText.split('\n');
    let lat = 0, lng = 0;

    for (const line of lines) {
      if (line.toLowerCase().includes(lead.name.toLowerCase().substring(0, 10)) ||
          line.toLowerCase().includes(lead.address.toLowerCase().substring(0, 10))) {
        const nums = line.match(/-?\d+\.\d+/g);
        if (nums && nums.length >= 2) {
          lat = parseFloat(nums[0]);
          lng = parseFloat(nums[1]);
          break;
        }
      }
    }

    return {
      ...lead,
      id: `lead-${index}-${Date.now()}`,
      lat: lat || (userCoords?.lat || 0),
      lng: lng || (userCoords?.lng || 0),
      ownerName: lead.ownerName || 'Independent Owner',
      numLocations: lead.numLocations || 0,  // 0 means unknown, will display as "N/A"
      confidence: lead.confidence || 'medium',
      sourceUrls: groundingLinks.map(l => l.uri)
    };
  }).filter(l => l.lat !== 0 && !isNaN(l.lat));

  console.log('[FuelProspector] Final leads with coordinates:', finalLeads.length);
  return { leads: finalLeads, groundingLinks };
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

    LEADS TO SEQUENCE:
    ${leads.map(l => `ID: ${l.id} | Name: ${l.name} | Address: ${l.address} | LatLng: ${l.lat},${l.lng}`).join('\n')}

    INSTRUCTIONS:
    1. Calculate the most logical "next-nearest-neighbor" route.
    2. Minimize backtracking.
    3. Return ONLY a plain text list of lead IDs in the optimized sequence, one per line.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        temperature: 0.1
      }
    });

    const text = response.text || "";
    console.log('[FuelProspector] Route optimization response:', text.substring(0, 200));

    const validIds = leads.map(l => l.id);
    const foundIds = text.split('\n')
      .map(line => line.trim())
      .map(line => validIds.find(id => line.includes(id)))
      .filter((id): id is string => !!id);

    if (foundIds.length === 0) {
      console.log('[FuelProspector] Route optimization: No valid IDs found, using default order');
      return leads.map(l => l.id);
    }

    console.log('[FuelProspector] Route optimization complete:', foundIds.length, 'leads ordered');
    return foundIds;
  } catch (error: any) {
    console.error('[FuelProspector] Route optimization ERROR:', error.message);
    console.error('[FuelProspector] Full error:', error);
    return leads.map(l => l.id);
  }
};
