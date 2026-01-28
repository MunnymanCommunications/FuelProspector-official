
import { GoogleGenAI, Type } from "@google/genai";
import { GasStationLead, GroundingLink } from "../types";

export const findLeads = async (location: string, userCoords?: { lat: number, lng: number }): Promise<{ 
  leads: GasStationLead[], 
  groundingLinks: GroundingLink[] 
}> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // PHASE 1: Rapid Site Discovery
  const discoveryPrompt = `
    Find every independent gas station and small local chain operating in or near "${location}".
    
    INSTRUCTIONS:
    1. Identify brands like "Stop & Save", "Quick-Stop", and other non-national entities.
    2. For every brand found, you MUST list the physical address of EVERY location they have in this area.
    3. Include "mom-and-pop" standalone stations.
    4. Exclude major national chains (Shell, Exxon, BP, etc.).
    
    Return a JSON array of objects with 'name', 'address', and 'brand'.
  `;

  const discoveryResponse = await ai.models.generateContent({
    model: "gemini-2.0-flash",
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

  const discoveredSites = JSON.parse(discoveryResponse.text || "[]");
  
  if (discoveredSites.length === 0) return { leads: [], groundingLinks: [] };

  // PHASE 2: Rapid Enrichment & Filtering
  const enrichmentPrompt = `
    LEAD VERIFICATION for "${location}":
    
    Sites to verify: ${JSON.stringify(discoveredSites.slice(0, 50))}
    
    TASK:
    1. For each site, confirm the owner manages 10 or FEWER locations total.
    2. If they qualify, harvest:
       - Owner/Principal Name
       - Precise location count
       - Contact Phone
       - Business Email
       - Website
    
    Return ONLY qualified leads as a JSON array.
  `;

  const enrichmentResponse = await ai.models.generateContent({
    model: "gemini-2.0-flash",
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
          required: ['name', 'address', 'ownerName', 'numLocations']
        }
      }
    }
  });

  const enrichedLeads = JSON.parse(enrichmentResponse.text || "[]");
  const groundingLinks: GroundingLink[] = [];
  enrichmentResponse.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((chunk: any) => {
    if (chunk.web) groundingLinks.push({ uri: chunk.web.uri, title: chunk.web.title });
  });

  // PHASE 3: Precise Geocoding
  const geocodePrompt = `
    Provide coordinates for these physical locations:
    ${enrichedLeads.map((l: any) => `${l.name} at ${l.address}`).join('\n')}
    
    Format: [Name] | [Lat] | [Lng]
  `;

  const geoResponse = await ai.models.generateContent({
    model: "gemini-2.0-flash",
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
      sourceUrls: groundingLinks.map(l => l.uri)
    };
  }).filter(l => l.lat !== 0 && !isNaN(l.lat));

  return { leads: finalLeads, groundingLinks };
};

export const optimizeRouteOrder = async (
  leads: GasStationLead[], 
  startLocation: string, 
  userCoords?: { lat: number, lng: number }
): Promise<string[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // Explicitly prompt for the shortest path problem (TSP)
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

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      temperature: 0.1 // Keep output deterministic and focused on logic
    }
  });

  const text = response.text || "";
  const validIds = leads.map(l => l.id);
  const foundIds = text.split('\n')
    .map(line => line.trim())
    .map(line => validIds.find(id => line.includes(id)))
    .filter((id): id is string => !!id);

  // Fallback: if AI failed to return all IDs, ensure we still have a list
  if (foundIds.length === 0) return leads.map(l => l.id);
  
  return foundIds;
};
