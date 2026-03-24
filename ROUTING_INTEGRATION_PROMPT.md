# FuelProspector Integration Prompt for Routing Application

> **Purpose**: Hand this document to a coding agent to integrate FuelProspector's lead-discovery engine as a tool within an existing routing application that has route legs. The goal is to let dispatchers/sales teams discover independent gas station leads along routes they are already planning.

---

## 1. What You Are Building

Add a "Prospect Along Route" feature to the existing routing application. When a user has a planned route with legs (origin -> waypoint A -> waypoint B -> destination), the system should:

1. **For each leg** of the route, query the FuelProspector engine to discover independent gas stations within a configurable corridor (e.g., 5-mile radius of the leg's path).
2. **Aggregate and deduplicate** results across all legs into a unified lead list.
3. **Optionally enrich** leads with owner/contact info on demand.
4. **Display leads on the route map** as markers alongside the existing route visualization.
5. **Allow users to add a lead as a stop** on their existing route, re-optimizing the leg sequence.

---

## 2. FuelProspector System Overview

FuelProspector is a client-side AI-powered prospecting engine. It has **no backend server or database**. All intelligence comes from Google Gemini API calls with Google Search and Google Maps grounding. Here is the complete architecture:

### 2.1 Technology Stack

- **AI Engine**: Google Gemini API (`@google/genai` SDK)
  - Models used: `gemini-3-flash-preview` (discovery, enrichment, routing), `gemini-2.5-flash` (geocoding)
  - Grounding tools: `googleSearch` (lead discovery/enrichment), `googleMaps` (geocoding)
- **Mapping**: Leaflet + `leaflet-routing-machine` (uses OpenRouteService for route calculation)
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS
- **Auth**: Simple PIN-based (not relevant to integration)
- **Persistence**: None (in-memory state only, CSV export for download)

### 2.2 Required API Setup

```
GEMINI_API_KEY=<your-google-gemini-api-key>
```

The Gemini API key must have these capabilities enabled:
- Generative Language API
- Google Search Grounding (may require paid tier)
- Google Maps Grounding (may require paid tier)

---

## 3. Core Data Structures

These are the TypeScript interfaces the system uses. Your integration should adopt or adapt these:

```typescript
interface GasStationLead {
  id: string;                              // Unique identifier (e.g., "lead-0-1709234567890")
  name: string;                            // Station/company name
  address: string;                         // Physical street address
  lat: number;                             // Latitude (0 if geocoding failed)
  lng: number;                             // Longitude (0 if geocoding failed)
  ownerName?: string;                      // Business owner/manager name
  numLocations?: number;                   // Number of locations they operate
  contactInfo?: string;                    // Business phone number
  email?: string;                          // Business email
  website?: string;                        // Website URL
  confidence: 'high' | 'medium' | 'low';  // Data confidence level
  sourceUrls: string[];                    // Grounding source URLs
  isEnriched: boolean;                     // Whether enrichment has been run
  isEnriching?: boolean;                   // Currently being enriched
}

interface GroundingLink {
  uri: string;
  title: string;
}

interface EnrichmentProgress {
  current: number;
  total: number;
  currentName?: string;
}
```

---

## 4. Core Functions to Integrate (Service Layer)

The entire prospecting engine lives in a single service file. Below are the exact function signatures, what they do, and how to call them. **You should extract these into a standalone service module** in the routing app.

### 4.1 `discoverLeads(location, userCoords?)` — Find Gas Stations

**Purpose**: Given a location string, discover all independent/small-chain gas stations nearby.

**Signature**:
```typescript
async function discoverLeads(
  location: string,                           // e.g., "Denver, CO" or "I-70 between Denver and Grand Junction"
  userCoords?: { lat: number; lng: number }   // Optional bias point for geocoding accuracy
): Promise<{
  leads: GasStationLead[];
  groundingLinks: GroundingLink[];
}>
```

**How it works internally (two phases)**:

**Phase 1 — AI Discovery**: Calls `gemini-3-flash-preview` with `googleSearch` grounding. The prompt asks:
```
Find every independent gas station and small local chain operating in or near "{location}".
- Identify brands like "Stop & Save", "Quick-Stop", non-national entities
- List EVERY physical address for each brand found
- Include mom-and-pop standalone stations
- Exclude major national chains (Shell, Exxon, BP, etc.)
Return JSON array: [{name, address, brand}]
```
Response uses structured JSON schema to guarantee parseable output.

**Phase 2 — Geocoding**: Calls `gemini-2.5-flash` with `googleMaps` grounding. Sends all discovered site names+addresses and gets back `[Name] | [Lat] | [Lng]` lines. Coordinates are fuzzy-matched back to discovered sites.

**Key adaptation for routing**: Instead of a single city/zip, you will call this **per route leg** using descriptive location strings like:
- `"Along I-70 between mile marker 200 and 250 near Vail, CO"`
- `"Within 5 miles of US-287 between Fort Collins and Loveland, CO"`
- Or simply the city/town names that each leg passes through

### 4.2 `enrichSingleLead(lead)` — Enrich One Lead

**Purpose**: Get owner name, phone, email, website for a specific gas station.

**Signature**:
```typescript
async function enrichSingleLead(lead: GasStationLead): Promise<GasStationLead>
```

**How it works**: Calls `gemini-3-flash-preview` with `googleSearch` grounding. Prompt:
```
Find detailed business information for this gas station:
Name: {name}, Address: {address}
Search for: Owner/Principal Name, Number of locations, Phone, Email, Website
Return JSON: {ownerName, numLocations, contactInfo, email, website, confidence}
```

Returns the original lead merged with enrichment data. On failure, returns lead with defaults (`ownerName: "Independent Owner"`, `confidence: "low"`).

### 4.3 `enrichLeads(leads, location, onProgress?, onLeadEnriched?)` — Bulk Enrich

**Purpose**: Enrich multiple leads with progress callbacks.

**Signature**:
```typescript
async function enrichLeads(
  leads: GasStationLead[],
  location: string,
  onProgress?: (progress: EnrichmentProgress) => void,
  onLeadEnriched?: (lead: GasStationLead) => void
): Promise<{
  leads: GasStationLead[];
  groundingLinks: GroundingLink[];
}>
```

**How it works**: Processes leads in **batches of 5**. Each batch sends all 5 leads in a single Gemini call. Results are fuzzy-matched back by name/address substring. Progress callbacks fire after each batch for real-time UI updates.

### 4.4 `optimizeRouteOrder(leads, startLocation, userCoords?)` — Sequence Leads

**Purpose**: Given a set of leads, order them for shortest driving distance.

**Signature**:
```typescript
async function optimizeRouteOrder(
  leads: GasStationLead[],
  startLocation: string,
  userCoords?: { lat: number; lng: number }
): Promise<string[]>  // Returns ordered array of lead IDs
```

**How it works**: Calls `gemini-3-flash-preview` (temperature=0.1 for determinism). Sends all lead IDs, names, addresses, and coordinates. Returns IDs in optimized nearest-neighbor sequence.

**Key adaptation for routing**: You likely already have route optimization in your routing app. You may want to use YOUR OWN routing engine to insert leads as stops rather than using this function. This function is most useful if you want to optimize a sub-route of just the discovered leads.

---

## 5. Integration Architecture

### 5.1 Recommended Approach: Service Module Integration

```
your-routing-app/
├── services/
│   ├── routeService.ts          # Your existing route/leg management
│   └── fuelProspectorService.ts # NEW — extracted from FuelProspector
├── components/
│   ├── RouteMap.tsx             # Your existing map
│   ├── RouteLegList.tsx         # Your existing leg list
│   └── LeadPanel.tsx            # NEW — shows discovered leads
```

### 5.2 The Key New Service: `fuelProspectorService.ts`

Create this file by extracting the core logic from FuelProspector's `geminiService.ts`. It needs:

```typescript
import { GoogleGenAI, Type } from "@google/genai";

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DISCOVERY_MODEL = "gemini-3-flash-preview";
const GEOCODING_MODEL = "gemini-2.5-flash";
const BATCH_SIZE = 5;

// Export the 4 core functions:
export { discoverLeads, enrichSingleLead, enrichLeads, optimizeRouteOrder };
```

### 5.3 The Key New Function: `prospectAlongRoute(legs)`

This is the **new orchestration function** you need to write. It does not exist in FuelProspector — you are building it to bridge your routing app with the prospecting engine.

```typescript
interface RouteLeg {
  id: string;
  origin: { lat: number; lng: number; label: string };
  destination: { lat: number; lng: number; label: string };
  waypoints?: { lat: number; lng: number }[];  // Intermediate points along the leg
  distanceMiles?: number;
}

interface ProspectingOptions {
  corridorRadiusMiles?: number;    // How far from the route to search (default: 5)
  maxLeadsPerLeg?: number;         // Cap results per leg (default: 20)
  autoEnrich?: boolean;            // Immediately enrich or let user trigger (default: false)
  excludeChains?: string[];        // Additional chains to exclude
}

async function prospectAlongRoute(
  legs: RouteLeg[],
  options: ProspectingOptions = {}
): Promise<{
  leads: GasStationLead[];
  leadsByLeg: Map<string, GasStationLead[]>;  // Grouped by leg ID
  groundingLinks: GroundingLink[];
}> {
  const allLeads: GasStationLead[] = [];
  const leadsByLeg = new Map<string, GasStationLead[]>();
  const allGroundingLinks: GroundingLink[] = [];
  const seenAddresses = new Set<string>();  // For deduplication

  for (const leg of legs) {
    // Build a descriptive location string for this leg
    const locationQuery = buildLegLocationQuery(leg, options.corridorRadiusMiles ?? 5);

    // Use the midpoint of the leg as coordinate bias for geocoding
    const midpoint = {
      lat: (leg.origin.lat + leg.destination.lat) / 2,
      lng: (leg.origin.lng + leg.destination.lng) / 2,
    };

    // Call the core discovery function
    const { leads, groundingLinks } = await discoverLeads(locationQuery, midpoint);

    // Deduplicate by normalized address
    const newLeads = leads.filter(lead => {
      const normalized = lead.address.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seenAddresses.has(normalized)) return false;
      seenAddresses.add(normalized);
      return true;
    });

    // Optional: filter to only leads within corridor radius of the leg path
    const filteredLeads = filterLeadsByProximityToLeg(newLeads, leg, options.corridorRadiusMiles ?? 5);

    leadsByLeg.set(leg.id, filteredLeads);
    allLeads.push(...filteredLeads);
    allGroundingLinks.push(...groundingLinks);
  }

  // Optional auto-enrichment
  if (options.autoEnrich && allLeads.length > 0) {
    const enriched = await enrichLeads(allLeads, "route corridor");
    return {
      leads: enriched.leads,
      leadsByLeg,
      groundingLinks: [...allGroundingLinks, ...enriched.groundingLinks],
    };
  }

  return { leads: allLeads, leadsByLeg, groundingLinks: allGroundingLinks };
}
```

### 5.4 Helper: Build Location Query from a Leg

The FuelProspector discovery engine takes a **natural language location string** — not coordinates. You need to convert your route legs into descriptive text:

```typescript
function buildLegLocationQuery(leg: RouteLeg, radiusMiles: number): string {
  // Option A: Use city/town labels if available
  if (leg.origin.label && leg.destination.label) {
    return `Independent gas stations within ${radiusMiles} miles of the route between ${leg.origin.label} and ${leg.destination.label}`;
  }

  // Option B: Use coordinates with reverse-geocoded names
  return `Independent gas stations near the road corridor from (${leg.origin.lat}, ${leg.origin.lng}) to (${leg.destination.lat}, ${leg.destination.lng}), within ${radiusMiles} miles of the route`;
}
```

### 5.5 Helper: Filter Leads by Proximity to Leg

Since the AI may return stations outside your desired corridor, do a post-filter:

```typescript
function filterLeadsByProximityToLeg(
  leads: GasStationLead[],
  leg: RouteLeg,
  maxDistanceMiles: number
): GasStationLead[] {
  return leads.filter(lead => {
    if (lead.lat === 0 && lead.lng === 0) return true;  // Keep ungeolocated leads
    const distance = pointToSegmentDistanceMiles(
      { lat: lead.lat, lng: lead.lng },
      leg.origin,
      leg.destination
    );
    return distance <= maxDistanceMiles;
  });
}

// Haversine-based point-to-line-segment distance
function pointToSegmentDistanceMiles(
  point: { lat: number; lng: number },
  segStart: { lat: number; lng: number },
  segEnd: { lat: number; lng: number }
): number {
  // Project point onto the line segment, then compute haversine distance
  // to the nearest point on the segment. Implementation left to you —
  // use turf.js `pointToLineDistance` or implement haversine projection.
}
```

---

## 6. UI Integration Points

### 6.1 Route Map Overlay

Add discovered leads as a **separate marker layer** on your existing route map:

```typescript
// Leaflet marker example
leads.forEach(lead => {
  if (lead.lat && lead.lng) {
    L.marker([lead.lat, lead.lng], {
      icon: getConfidenceIcon(lead.confidence),  // Color by confidence
    })
    .bindPopup(`
      <b>${lead.name}</b><br>
      ${lead.address}<br>
      ${lead.ownerName ? `Owner: ${lead.ownerName}<br>` : ''}
      ${lead.contactInfo ? `Phone: ${lead.contactInfo}<br>` : ''}
      <button onclick="addAsStop('${lead.id}')">Add as Route Stop</button>
      <button onclick="enrichLead('${lead.id}')">Get Owner Info</button>
    `)
    .addTo(leadsLayer);
  }
});
```

### 6.2 Lead Panel (Sidebar or Drawer)

Show leads grouped by route leg:

```
Route: Denver → Vail → Grand Junction
├── Leg 1: Denver → Vail (3 leads found)
│   ├── Quick Stop Fuel - 1234 Main St, Idaho Springs
│   ├── Mountain Gas - 567 Hwy 6, Georgetown
│   └── Summit Fuel Co - 890 I-70, Silverthorne
├── Leg 2: Vail → Grand Junction (5 leads found)
│   ├── ...
```

Each lead card should show:
- Name, address, confidence badge
- "Enrich" button (fetches owner/contact info)
- "Add as Stop" button (inserts into route)
- "View on Map" button (pan/zoom to marker)

### 6.3 "Add as Stop" Flow

When a user clicks "Add as Stop" on a lead:
1. Insert the lead's coordinates as a new waypoint on the appropriate leg
2. Re-split the leg if needed (leg A→B becomes A→Lead→B)
3. Recalculate route distance/time using your routing engine
4. Update the map visualization

---

## 7. Performance & Rate Limiting Considerations

| Concern | Recommendation |
|---------|----------------|
| **Gemini API rate limits** | Process legs sequentially, not in parallel. Each `discoverLeads` call makes 2 API calls (discovery + geocoding). |
| **Long routes with many legs** | Consider only prospecting the 3-5 longest legs, or let the user select which legs to prospect. |
| **Enrichment cost** | Don't auto-enrich. Let users click "Enrich" on individual leads they're interested in. Bulk enrich only on explicit request. |
| **Caching** | Cache discovery results by location string + radius. Gas stations don't change frequently — a 24-hour cache is reasonable. |
| **Deduplication** | The same station may appear on adjacent legs. Deduplicate by normalized address before showing to user. |
| **Geocoding failures** | Some leads will come back with `lat: 0, lng: 0`. Keep them in the list (they're still valid leads) but don't show them on the map. |

---

## 8. Environment & Dependencies

Install these packages in your routing application:

```bash
npm install @google/genai
# You likely already have Leaflet — if not:
npm install leaflet leaflet-routing-machine
```

Environment variable:
```
GEMINI_API_KEY=your-key-here
```

If your routing app has a backend (unlike FuelProspector which is client-only), you should:
- **Move the Gemini API calls to the backend** to protect the API key
- Expose a REST endpoint like `POST /api/prospect-along-route` that accepts legs and returns leads
- This also lets you add server-side caching and rate limiting

---

## 9. Example End-to-End Flow

```
1. User plans route: Dallas → Austin → San Antonio
   - Leg 1: Dallas → Austin (195 miles)
   - Leg 2: Austin → San Antonio (80 miles)

2. User clicks "Find Fuel Leads Along Route"

3. System calls prospectAlongRoute([leg1, leg2], { corridorRadiusMiles: 5 })
   - For Leg 1: discoverLeads("Independent gas stations within 5 miles of I-35 between Dallas and Austin, TX")
     → Returns 12 leads (Buc-ee wannabes, local stops, independent operators)
   - For Leg 2: discoverLeads("Independent gas stations within 5 miles of I-35 between Austin and San Antonio, TX")
     → Returns 8 leads
   - Deduplicate: 18 unique leads total

4. Leads appear as orange markers on the route map
   - Sidebar shows leads grouped by leg
   - Each lead shows name + address

5. User clicks "Enrich" on "Lone Star Fuel Stop"
   - enrichSingleLead(lead) fires
   - Card updates: Owner: "James Rodriguez", Phone: "(512) 555-1234", Confidence: HIGH

6. User clicks "Add as Stop" on the enriched lead
   - Lead inserted as waypoint between Dallas and Austin
   - Route recalculated: Dallas → Lone Star Fuel Stop → Austin → San Antonio
   - New total distance and ETA shown

7. User exports lead list as CSV for CRM import
```

---

## 10. Key Prompt Templates (Copy These Exactly)

These are the exact prompts that make the AI discovery work. **Do not modify the core instructions** — they have been tuned for accuracy.

### Discovery Prompt
```
Find every independent gas station and small local chain operating in or near "{location}".

INSTRUCTIONS:
1. Identify brands like "Stop & Save", "Quick-Stop", and other non-national entities.
2. For every brand found, you MUST list the physical address of EVERY location they have in this area.
3. Include "mom-and-pop" standalone stations.
4. Exclude major national chains (Shell, Exxon, BP, etc.).

Return a JSON array of objects with 'name', 'address', and 'brand'.
```

### Geocoding Prompt
```
Provide coordinates for these physical locations:
{name} at {address}
...

Format: [Name] | [Lat] | [Lng]
```

### Enrichment Prompt (Single Lead)
```
Find detailed business information for this gas station:
Name: {name}
Address: {address}

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

Return a single JSON object with: ownerName, numLocations, contactInfo, email, website, confidence
```

### Enrichment Prompt (Batch)
```
LEAD ENRICHMENT for "{location}":

Sites to enrich:
1. {name} at {address}
2. {name} at {address}
...

TASK:
For EACH site listed above, search and find:
- Owner/Principal Name (if available)
- Number of locations they operate (only if verified, do NOT guess)
- Contact Phone
- Business Email
- Website

IMPORTANT:
- Return ALL {count} sites in your response
- If owner info cannot be found, use "Independent Owner" as the ownerName
- If location count is unknown, omit numLocations or set to 0
- Set confidence to "high" if owner verified, "medium" if partially verified, "low" if estimated

Return a JSON array with {count} objects.
```

---

## 11. Gemini API Call Patterns

### Discovery Call
```typescript
const response = await ai.models.generateContent({
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
```

### Geocoding Call
```typescript
const response = await ai.models.generateContent({
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
```

### Enrichment Call (with JSON schema)
```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: enrichmentPrompt,
  config: {
    tools: [{ googleSearch: {} }],
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        ownerName: { type: Type.STRING },
        numLocations: { type: Type.NUMBER },
        contactInfo: { type: Type.STRING },
        email: { type: Type.STRING },
        website: { type: Type.STRING },
        confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] }
      }
    }
  }
});
```

---

## 12. Checklist for the Coding Agent

- [ ] Install `@google/genai` in the routing application
- [ ] Create `fuelProspectorService.ts` with all 4 core functions extracted from this doc
- [ ] Create `prospectAlongRoute()` orchestration function that iterates over route legs
- [ ] Implement `buildLegLocationQuery()` to convert legs into natural language location strings
- [ ] Implement deduplication by normalized address
- [ ] Implement proximity filtering (point-to-line-segment distance)
- [ ] Add a "Prospect Along Route" button to the route planning UI
- [ ] Add a leads marker layer to the existing map (separate from route markers)
- [ ] Add a leads panel/sidebar showing results grouped by leg
- [ ] Add "Enrich" button per lead that calls `enrichSingleLead()`
- [ ] Add "Add as Stop" button that inserts lead coordinates as a waypoint
- [ ] Add CSV export for discovered leads
- [ ] Add loading/progress indicators during discovery and enrichment
- [ ] Configure `GEMINI_API_KEY` environment variable
- [ ] If backend exists: move Gemini calls server-side and expose via REST API
- [ ] Add caching layer for discovery results (24-hour TTL by location string)
- [ ] Handle edge cases: empty results, geocoding failures (lat/lng = 0), API errors
